import {
  Client,
  GatewayIntentBits,
  ActivityType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type VoiceState,
} from 'discord.js';
import { config } from './config.js';
import { spotify } from './spotify.js';
import { audioEngine } from './audio.js';
import { memoryManager } from './memory.js';
import { createVoiceSessionManager } from './voice-session.js';
import { emitHealth } from './health.js';
import { nluRouter } from './nlu/router.js';
import { extractDirectPlayQuery, extractSpotifyReference } from './spotify-utils.js';
import { playbackActivityName } from './presence.js';
import type { PlaybackState, PlayResult } from './types.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    // Required to read message content for the @mention NLU router.
    GatewayIntentBits.MessageContent,
  ],
});

export const voiceSession = createVoiceSessionManager({ audioEngine, spotify, config });
const PRESENCE_SYNC_INTERVAL_MS = 15_000;
let lastActivityName: string | null | undefined;
let presenceSyncRunning = false;
let nowPlayingActive = false;

/**
 * Surface the host's current track to the desktop now-playing hero. Emitted every
 * poll while a track is active (so the renderer can re-anchor its interpolated
 * progress bar), and once when playback stops.
 */
function emitNowPlaying(state: PlaybackState | null): void {
  if (state?.track) {
    const { guildName, channelName } = voiceSession.getActiveContext();
    emitHealth('now_playing', {
      title: state.track.name,
      artist: state.track.artists,
      albumArtUrl: state.track.albumArtUrl ?? null,
      isPlaying: state.isPlaying,
      progressMs: state.progressMs ?? null,
      durationMs: state.track.durationMs ?? null,
      guildName: guildName ?? null,
      channelName: channelName ?? null,
      sampledAt: Date.now(),
    });
    nowPlayingActive = true;
  } else if (nowPlayingActive) {
    nowPlayingActive = false;
    emitHealth('now_playing', { track: null });
  }
}

async function syncPlaybackPresence(): Promise<void> {
  if (presenceSyncRunning || !client.user) return;
  presenceSyncRunning = true;
  try {
    const spotifyUserId = voiceSession.getActiveSpotifyUserId();
    const state = spotifyUserId ? await spotify.getPlaybackState(spotifyUserId) : null;
    emitNowPlaying(state);

    const activityName = state ? playbackActivityName(state) : null;
    if (activityName === lastActivityName) return;
    lastActivityName = activityName;
    client.user.setPresence({
      activities: activityName ? [{ name: activityName, type: ActivityType.Listening }] : [],
    });
  } finally {
    presenceSyncRunning = false;
  }
}

function refreshPlaybackPresence(): void {
  setTimeout(() => void syncPlaybackPresence(), 1_000);
}

async function replyEphemeral(cmd: ChatInputCommandInteraction, content: string): Promise<void> {
  await cmd.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Join voice, route Spotify to the virtual cable, and rebind playback onto that output. */
async function prepareVoiceStreaming(
  member: NonNullable<ChatInputCommandInteraction<'cached'>['member']>,
  guild: ChatInputCommandInteraction<'cached'>['guild'],
  spotifyUserId: string,
): Promise<void> {
  await voiceSession.ensureVoiceConnection(member, guild, spotifyUserId, false);
  await voiceSession.routeSpotifyAudioForUser(spotifyUserId);
  const device = await spotify.findTargetDevice(spotifyUserId);
  await spotify.resumeOnRoutedDevice(spotifyUserId, device?.id ?? null);
}

async function startDiscordCapture(spotifyUserId: string): Promise<void> {
  const capture = await voiceSession.startCapture(spotifyUserId);
  await capture.readyPromise;
}

async function handleInteractionFailure(cmd: ChatInputCommandInteraction, err: unknown): Promise<void> {
  const message = (err as Error).message || 'Unknown error';
  console.error('[Bot] Interaction failed:', message);
  const content = `Something went wrong: ${message}`;
  try {
    if (cmd.deferred || cmd.replied) {
      await cmd.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await cmd.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    console.error('[Bot] Could not send interaction error response:', (replyErr as Error).message);
  }
}

client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
  voiceSession.handleVoiceStateUpdate(oldState, newState);
});

// ----------------------------------------------------
// Slash Command Handler
// ----------------------------------------------------
client.on('interactionCreate', (interaction) => {
  void (async () => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'Commands must be used inside a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const cmd = interaction as ChatInputCommandInteraction<'cached'>;
    try {
      const { commandName, member, guild, user } = cmd;
      const userId = user.id;

      if (commandName === 'login') {
        spotify.startAuthServer();
        await replyEphemeral(cmd, `Link your Spotify Premium account: [Authorize Spotify Connect](${spotify.getLoginUrl(userId)})`);
        return;
      }

      if (commandName === 'play') {
        if (!member.voice.channel) {
          await replyEphemeral(cmd, 'You must be in a voice channel to use this command!');
          return;
        }
        if (!spotify.isUserAuthenticated(userId)) {
          spotify.startAuthServer();
          await replyEphemeral(cmd, `Spotify link required: [Link Account](${spotify.getLoginUrl(userId)})`);
          return;
        }
        await cmd.deferReply();
        try {
          await cmd.editReply('Joining your voice channel...');
          const voiceChannel = await voiceSession.ensureVoiceConnection(member, guild, userId, false);
          let playError: string | null = null;
          let targetDeviceName = 'your active device';
          try {
            await cmd.editReply('Routing Spotify audio to Discord...');
            await prepareVoiceStreaming(member, guild, userId);
            const device = await spotify.findTargetDevice(userId);
            if (device) targetDeviceName = device.name;
            await startDiscordCapture(userId);
          } catch (err) {
            console.warn('[Bot] Voice streaming setup failed:', (err as Error).message);
            playError = (err as Error).message;
            voiceSession.cleanup();
          }
          const replyContent = playError
            ? `Could not stream audio: ${playError}`
            : `Connected to **${voiceChannel.name}**. Spotify auto-resumed on **${targetDeviceName}**.`;
          const reply = await cmd.editReply(replyContent);
          refreshPlaybackPresence();
          setTimeout(() => void reply.delete().catch(() => {}), 5000);
        } catch (err) {
          console.error('[Bot] Failed to join voice/setup audio:', (err as Error).message);
          voiceSession.cleanup();
          await cmd.editReply({ content: `Failed to join voice channel or setup audio: ${(err as Error).message}` });
        }
        return;
      }

      if (commandName === 'queue') {
        await cmd.deferReply();
        const rawQuery = cmd.options.getString('query', true);
        try {
          const result = await spotify.queueTrack(userId, rawQuery);
          await cmd.editReply(formatQueueResult(result));
        } catch (err) {
          await cmd.editReply(`Failed to queue: ${(err as Error).message}`);
        }
        return;
      }

      if (commandName === 'clearqueue') {
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const result = await spotify.clearQueue(userId);
          await cmd.editReply(result.message ?? 'Queue cleared.');
        } catch (err) {
          await cmd.editReply(`Failed to clear queue: ${(err as Error).message}`);
        }
        return;
      }

      if (commandName === 'stop') {
        await cmd.deferReply();
        try {
          try {
            const device = await spotify.findTargetDevice(userId);
            await spotify.pause(userId, device?.id ?? null);
          } catch (err) {
            console.warn('[Bot] Spotify pause failed during stop:', (err as Error).message);
          }
          voiceSession.cleanup();
          refreshPlaybackPresence();
          const reply = await cmd.editReply('Stopped streaming and paused Spotify.');
          setTimeout(() => void reply.delete().catch(() => {}), 5000);
        } catch (err) {
          console.error('[Bot] Error during stop:', (err as Error).message);
          voiceSession.cleanup();
          refreshPlaybackPresence();
          await cmd.editReply('Disconnected from voice (Spotify pause could not complete).');
        }
        return;
      }

      if (commandName === 'effect') {
        if (!voiceSession.isActive()) {
          await replyEphemeral(cmd, 'The bot must be active in a voice channel to apply live effects!');
          return;
        }
        const type = cmd.options.getString('type', true);
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          voiceSession.updateEffects(type);
          await voiceSession.reapplyCapture(userId);
          await cmd.editReply({ content: `Effects updated: ${voiceSession.getEffectStatus()}` });
        } catch (err) {
          console.error('[Bot] Failed to apply effects:', (err as Error).message);
          await cmd.editReply({ content: `Failed to apply effects: ${(err as Error).message}` });
        }
      }
    } catch (err) {
      await handleInteractionFailure(cmd, err);
    }
  })();
});

spotify.on('authenticated', (discordUserId: string) => {
  console.log(`[Bot] Spotify linked for user ${discordUserId}`);
});

client.once('clientReady', () => {
  const tag = client.user?.tag ?? 'unknown';
  console.log(`\x1b[32m[Discord] Logged in as ${tag}!\x1b[0m`);
  emitHealth('discord_ready', { tag });
  void syncPlaybackPresence();
  setInterval(() => void syncPlaybackPresence(), PRESENCE_SYNC_INTERVAL_MS);
  const profilesCount = Object.keys(spotify.profiles).length;
  console.log(`[Bot] Ready. Loaded ${profilesCount} user profile mapping(s).`);
});

// Handle @mention messages e.g. "@bot play UK garage" or "@bot boost the bass"
client.on('messageCreate', (message: Message) => {
  void (async () => {
    if (message.author.bot) return;
    if (!client.user || !message.mentions.has(client.user)) return;
    if (!message.inGuild()) return;

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const cleanContent = message.content.replace(mentionRegex, '').trim();

    let spotifyUserId = message.author.id;
    if (!spotify.isUserAuthenticated(spotifyUserId)) {
      const profiles = Object.keys(spotify.profiles);
      const first = profiles[0];
      if (first) {
        spotifyUserId = first;
      } else {
        await message.reply('No Spotify accounts have been linked yet. Use `/login` first!');
        return;
      }
    }

    // Conversational learning state.
    const pending = memoryManager.getPending(message.author.id);
    if (pending) {
      const cleanText = cleanContent.toLowerCase();
      if (cleanText === 'cancel') {
        memoryManager.clearPending(message.author.id);
        await message.reply('Cancelled conversational learning.');
        return;
      }
      const isMatch = cleanContent.match(new RegExp(`${pending.aliasName}\\s+is\\s+(.+)$`, 'i')) ?? cleanContent.match(/is\s+(.+)$/i);
      const spotifyInput = isMatch?.[1]?.trim() ?? cleanContent.trim();
      const loadingMsg = await message.reply(`Learning... mapping **${pending.aliasName}** to Spotify user "${spotifyInput}"...`);
      try {
        const userLinkMatch = spotifyInput.match(/open\.spotify\.com\/user\/([a-zA-Z0-9_-]+)/i) ?? spotifyInput.match(/spotify:user:([a-zA-Z0-9_-]+)/i);
        let resolvedUserId: string;
        let resolvedDisplayName: string;
        if (userLinkMatch?.[1]) {
          resolvedUserId = userLinkMatch[1];
          try {
            const userProfile = await spotify.request<{ display_name?: string }>(spotifyUserId, `/users/${resolvedUserId}`, 'GET');
            resolvedDisplayName = userProfile?.display_name ?? pending.aliasName;
          } catch {
            resolvedDisplayName = pending.aliasName;
          }
        } else {
          const res = await spotify.resolveUserDisplayName(spotifyUserId, spotifyInput);
          resolvedUserId = res.spotifyUserId;
          resolvedDisplayName = res.spotifyDisplayName;
        }
        memoryManager.setAlias(pending.aliasName, resolvedUserId, resolvedDisplayName);
        memoryManager.clearPending(message.author.id);
        await loadingMsg.edit(`Memory updated! Mapped **${pending.aliasName}** to **${resolvedDisplayName}**.`);

        const autoPlayMsg = await message.reply(`Spinning **${resolvedDisplayName}**'s playlist matching "${pending.targetQuery}"...`);
        try {
          if (message.member) await prepareVoiceStreaming(message.member, message.guild, spotifyUserId);
          const result = await spotify.playUserPlaylist(spotifyUserId, resolvedUserId, pending.targetQuery);
          if (message.member) await startDiscordCapture(spotifyUserId);
          await autoPlayMsg.edit(`Playing **${result.playlistName}** by **${resolvedDisplayName}** on **${result.deviceName}**.`);
          refreshPlaybackPresence();
          setTimeout(() => void autoPlayMsg.delete().catch(() => {}), 5000);
        } catch (playErr) {
          await autoPlayMsg.edit(`Failed to auto-play playlist: ${(playErr as Error).message}`);
          setTimeout(() => void autoPlayMsg.delete().catch(() => {}), 5000);
        }
      } catch (err) {
        console.error('[Bot] Conversational learning failed:', (err as Error).message);
        await loadingMsg.edit(`Failed to learn mapping: ${(err as Error).message}. Try again or reply "cancel".`);
      }
      return;
    }

    const parsed = await nluRouter.classify(cleanContent);
    console.log(`[SemanticParser] "${cleanContent}" -> ${parsed.intent}`);

    if (parsed.response) {
      const aiDJMsg = await message.reply(parsed.response);
      setTimeout(() => void aiDJMsg.delete().catch(() => {}), 5000);
    }

    let intent = parsed.intent;
    let friend = parsed.friend;
    let target = parsed.target;

    // PLAY against a known friend alias becomes FRIEND_PLAY.
    if (intent === 'PLAY' && parsed.query) {
      const potentialAlias = parsed.query.toLowerCase().trim();
      if (memoryManager.resolveAlias(potentialAlias)) {
        intent = 'FRIEND_PLAY';
        friend = potentialAlias;
        target = 'playlist';
      }
    }

    if (intent === 'GREET') {
      await message.reply("Yo! Ask me to `play [song/vibe]`, `play drew's playlist`, queue, adjust filters (`boost the bass`, `speed up`), or link with `login`!");
      return;
    }
    if (intent === 'LOGIN') {
      await message.reply(`Link your Spotify: [Authorize Spotify](${spotify.getLoginUrl(message.author.id)})`);
      return;
    }
    if (intent === 'STATUS') {
      const state = await spotify.getPlaybackState(spotifyUserId);
      await message.reply(
        state.track
          ? `Now playing: **${state.track.name}** by **${state.track.artists}** [${state.isPlaying ? 'Active' : 'Paused'}]`
          : 'Spotify is currently inactive or not playing on your host client.',
      );
      return;
    }
    if (intent === 'STOP') {
      const loadingMsg = await message.reply('Stopping streaming and disconnecting...');
      try {
        const device = await spotify.findTargetDevice(spotifyUserId);
        await spotify.pause(spotifyUserId, device?.id ?? null).catch(() => {});
      } catch {
        // ignore
      }
      voiceSession.cleanup();
      refreshPlaybackPresence();
      await loadingMsg.edit('Disconnected and paused Spotify.');
      setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      return;
    }
    if (intent === 'QUEUE') {
      if (!parsed.query) {
        await message.reply('Tell me what to queue! E.g. `@bot queue uk garage` or paste a Spotify track/playlist link.');
        return;
      }
      const loadingMsg = await message.reply('Queueing on Spotify...');
      try {
        const result = await spotify.queueTrack(spotifyUserId, parsed.query);
        await loadingMsg.edit(formatQueueResult(result));
      } catch (err) {
        await loadingMsg.edit(`Failed to queue: ${(err as Error).message}`);
      }
      setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      return;
    }
    if (intent === 'CLEAR_QUEUE') {
      const loadingMsg = await message.reply('Clearing Spotify queue...');
      try {
        const result = await spotify.clearQueue(spotifyUserId);
        await loadingMsg.edit(result.message ?? 'Queue cleared.');
      } catch (err) {
        await loadingMsg.edit(`Failed to clear queue: ${(err as Error).message}`);
      }
      setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      return;
    }
    if (intent.startsWith('EFFECT_')) {
      if (!voiceSession.isActive()) {
        await message.reply('I must be actively streaming in a voice channel to apply live effects!');
        return;
      }
      const loadingMsg = await message.reply('Modifying live audio filters...');
      try {
        voiceSession.updateEffects(intent.replace('EFFECT_', '').toLowerCase());
        await voiceSession.reapplyCapture(spotifyUserId);
        await loadingMsg.edit(`Live effects updated: ${voiceSession.getEffectStatus()}`);
      } catch (err) {
        await loadingMsg.edit(`Failed to apply effects: ${(err as Error).message}`);
      }
      setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      return;
    }
    if (intent === 'FRIEND_PLAY') {
      const friendName = friend ?? '';
      const targetQuery = target ?? 'playlist';
      const resolved = memoryManager.resolveAlias(friendName);
      if (!resolved) {
        memoryManager.setPending(message.author.id, friendName, targetQuery);
        await message.reply(`I don't know who **${friendName}** is yet! Teach me: **${friendName} is [Spotify Username/Display Name]** (or send their Spotify profile link).`);
        return;
      }
      const loadingMsg = await message.reply(`Fetching **${resolved.spotifyDisplayName}**'s playlist matching "${targetQuery}"...`);
      try {
        if (message.member) await prepareVoiceStreaming(message.member, message.guild, spotifyUserId);
        const result = await spotify.playUserPlaylist(spotifyUserId, resolved.spotifyUserId, targetQuery);
        if (message.member) await startDiscordCapture(spotifyUserId);
        await loadingMsg.edit(`Playing **${result.playlistName}** by **${resolved.spotifyDisplayName}** on **${result.deviceName}**.`);
        refreshPlaybackPresence();
      } catch (err) {
        await loadingMsg.edit(`Failed to play: ${(err as Error).message}`);
      }
      setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      return;
    }
    if (intent === 'PLAY') {
      const playQuery = extractDirectPlayQuery(cleanContent) ?? parsed.query;
      if (!playQuery) {
        await message.reply('Tell me what song or vibe to play! E.g. `@bot play uk garage`');
        return;
      }
      const loadingMsg = await message.reply('Searching Spotify...');
      try {
        if (message.member) await prepareVoiceStreaming(message.member, message.guild, spotifyUserId);
        const reference = extractSpotifyReference(playQuery);
        let result;
        if (reference) {
          const device = await spotify.findTargetDevice(spotifyUserId);
          const deviceParam = device?.id ? `?device_id=${device.id}` : '';
          const playBody = reference.type === 'track' ? { uris: [reference.uri] } : { context_uri: reference.uri };
          await spotify.request(spotifyUserId, `/me/player/play${deviceParam}`, 'PUT', playBody);
          result = { matchName: `Spotify Link (${reference.type})`, deviceName: device?.name ?? 'Active Host Client' };
        } else {
          result = await spotify.searchAndPlay(spotifyUserId, playQuery);
        }
        if (message.member) await startDiscordCapture(spotifyUserId);
        await loadingMsg.edit(`Playing **${result.matchName}** on **${result.deviceName}**.`);
        refreshPlaybackPresence();
        setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      } catch (err) {
        console.error('[Bot] Message play failed:', (err as Error).message);
        await loadingMsg.edit(`Failed to play: ${(err as Error).message}`);
        setTimeout(() => void loadingMsg.delete().catch(() => {}), 5000);
      }
    }
  })();
});

function formatQueueResult(result: PlayResult): string {
  if (result.matchType === 'playlist') {
    const count = result.queuedCount ?? 0;
    const skipped = result.skippedCount ? ` (${result.skippedCount} unavailable skipped)` : '';
    const capped = result.message ? ` ${result.message}` : '';
    return `Queued **${result.matchName}**: ${count} track${count === 1 ? '' : 's'} on **${result.deviceName}**.${skipped}${capped}`;
  }
  return `Queued **${result.matchName}** on **${result.deviceName}**.`;
}
