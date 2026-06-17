import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import { emitHealth } from './health.js';
import type { AudioCaptureEngine, CaptureHandle } from './audio.js';
import type { SpotifyController } from './spotify.js';
import type { AudioEffects } from './types.js';
import type { GreenroomConfig } from './config.js';
import { restoreSpotifyOutput, routeSpotifyToCapture } from './windows-audio-router.js';

export interface VoiceSessionDeps {
  audioEngine: AudioCaptureEngine;
  spotify: SpotifyController;
  config: GreenroomConfig;
}

const EMPTY_CHANNEL_TIMEOUT_MS = 45_000;
const VOICE_READY_TIMEOUT_MS = 15_000;
const VOICE_CONNECT_ATTEMPTS = 2;

function readableVoiceConnectError(err: Error | undefined): string {
  const raw = err?.message ?? 'unknown error';
  if (/aborted|timed out|timeout/i.test(raw)) {
    return 'Discord voice did not connect in time. Check that the bot can Connect and Speak in that voice channel, then try again. If it still fails, restart Discord or disable VPN/firewall rules that block Discord voice.';
  }
  return raw;
}

export class VoiceSessionManager {
  private readonly audioEngine: AudioCaptureEngine;
  private readonly spotify: SpotifyController;
  private readonly config: GreenroomConfig;
  private readonly audioPlayer: AudioPlayer;

  private voiceConnection: VoiceConnection | null = null;
  private currentChannelId: string | null = null;
  private currentChannelName: string | null = null;
  private currentGuildName: string | null = null;
  private activeSpotifyUserId: string | null = null;
  private autoDisconnectTimer: NodeJS.Timeout | null = null;
  private cleanupInProgress = false;
  private spotifyAudioRouted = false;
  private spotifyRouteInFlight: Promise<void> | null = null;
  private spotifyRestoreInFlight: Promise<void> | null = null;
  activeEffects: AudioEffects = { bassboost: false, speed: 1.0 };

  constructor(deps: VoiceSessionDeps) {
    this.audioEngine = deps.audioEngine;
    this.spotify = deps.spotify;
    this.config = deps.config;
    this.audioPlayer = createAudioPlayer();

    this.audioPlayer.on('error', (error) => {
      console.error('[DiscordVoicePlayer] Error:', error.message, error);
    });
    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      console.log('[DiscordVoicePlayer] Streaming loopback audio.');
    });
  }

  get isConnected(): boolean {
    return this.voiceConnection !== null;
  }

  isActive(): boolean {
    return this.voiceConnection !== null && this.audioEngine.isActive();
  }

  getActiveSpotifyUserId(): string | null {
    return this.isActive() ? this.activeSpotifyUserId : null;
  }

  getActiveContext(): { guildName: string | null; channelName: string | null } {
    return { guildName: this.currentGuildName, channelName: this.currentChannelName };
  }

  updateEffects(type: string): AudioEffects {
    if (type === 'bass' || type === 'bassboost') {
      this.activeEffects.bassboost = !this.activeEffects.bassboost;
    } else if (type === 'speedup') {
      this.activeEffects.speed = this.activeEffects.speed === 1.25 ? 1.0 : 1.25;
    } else if (type === 'slowed') {
      this.activeEffects.speed = this.activeEffects.speed === 0.8 ? 1.0 : 0.8;
    } else if (type === 'clear') {
      this.activeEffects.bassboost = false;
      this.activeEffects.speed = 1.0;
    }
    return this.activeEffects;
  }

  getEffectStatus(): string {
    const speed = this.activeEffects.speed;
    const speedLabel = speed === 1.25 ? '1.25x' : speed === 0.8 ? '0.8x' : 'Normal';
    return [
      `Bass Boost: **${this.activeEffects.bassboost ? 'ON' : 'OFF'}**`,
      `Speed: **${speedLabel}**`,
    ].join(' | ');
  }

  cleanup(): void {
    if (this.cleanupInProgress) return;
    this.cleanupInProgress = true;
    const hadActiveSession = this.voiceConnection !== null || this.audioEngine.isActive() || this.spotifyAudioRouted;
    if (this.autoDisconnectTimer) {
      clearTimeout(this.autoDisconnectTimer);
      this.autoDisconnectTimer = null;
    }
    this.audioEngine.stop();
    this.audioPlayer.stop();
    if (this.voiceConnection) {
      try {
        this.voiceConnection.destroy();
      } catch {
        // best-effort cleanup
      }
      this.voiceConnection = null;
    }
    this.currentChannelId = null;
    this.currentChannelName = null;
    this.currentGuildName = null;
    this.activeSpotifyUserId = null;
    void this.restoreSpotifyAudio();
    if (hadActiveSession) emitHealth('voice_stopped', {});
    console.log('[Bot] Voice connection and audio streams cleaned up.');
    this.cleanupInProgress = false;
  }

  async routeSpotifyAudio(captureDeviceName = this.config.audioDevice, force = false): Promise<void> {
    if (this.spotifyAudioRouted && !force) return;
    if (this.spotifyRouteInFlight) return this.spotifyRouteInFlight;

    this.spotifyRouteInFlight = (async () => {
      const route = await routeSpotifyToCapture(captureDeviceName, { dataDir: this.config.dataDir });
      if (route.ok) {
        if (!route.skipped) this.spotifyAudioRouted = true;
        console.log(`[AudioRouting] ${route.message}`);
      } else {
        console.warn(`[AudioRouting] Could not route Spotify automatically: ${route.message}`);
      }
    })();

    try {
      await this.spotifyRouteInFlight;
    } finally {
      this.spotifyRouteInFlight = null;
    }
  }

  async restoreSpotifyAudio(): Promise<void> {
    if (this.spotifyRouteInFlight) await this.spotifyRouteInFlight;
    if (!this.spotifyAudioRouted) return;
    if (this.spotifyRestoreInFlight) return this.spotifyRestoreInFlight;

    this.spotifyAudioRouted = false;
    this.spotifyRestoreInFlight = (async () => {
      const result = await restoreSpotifyOutput(this.config.audioDevice, { dataDir: this.config.dataDir });
      if (result.ok) console.log(`[AudioRouting] ${result.message}`);
      else console.warn(`[AudioRouting] Could not restore Spotify audio: ${result.message}`);
    })();

    try {
      await this.spotifyRestoreInFlight;
    } finally {
      this.spotifyRestoreInFlight = null;
    }
  }

  private async maximizeBitrate(voiceChannel: VoiceBasedChannel, guild: Guild): Promise<void> {
    try {
      const tier = guild.premiumTier;
      const maxBitrate = tier === 3 ? 384000 : tier === 2 ? 256000 : tier === 1 ? 128000 : 96000;
      if (voiceChannel.bitrate < maxBitrate) {
        console.log(`[Bot] Optimizing bitrate ${voiceChannel.bitrate} -> ${maxBitrate}bps`);
        await voiceChannel.setBitrate(maxBitrate);
      }
    } catch (err) {
      console.warn('[Bot] Could not optimize bitrate:', (err as Error).message);
    }
  }

  private attachConnectionLifecycle(connection: VoiceConnection): void {
    connection.on('stateChange', (oldState, newState) => {
      const oldStatus = oldState.status;
      const newStatus = newState.status;
      if (oldStatus !== newStatus) console.log(`[VoiceConnection] ${oldStatus} -> ${newStatus}`);
    });
    connection.on('error', (error) => {
      console.error('[VoiceConnection] Error:', error.message);
    });
    connection.on(VoiceConnectionStatus.Ready, () => {
      emitHealth('voice_ready', { channelId: this.currentChannelId });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('[Bot] Voice connection destroyed. Cleaning up.');
      this.cleanup();
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          console.log('[Bot] Voice disconnected permanently. Cleaning up.');
          this.cleanup();
        }
      })();
    });
  }

  private assertCanUseVoiceChannel(member: GuildMember, voiceChannel: VoiceBasedChannel, guild: Guild): void {
    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      throw new Error('Greenroom needs a regular voice channel. Stage channels are not supported yet.');
    }

    const botMember = guild.members.me;
    if (!botMember) {
      throw new Error('Discord has not finished loading the bot permissions yet. Try again in a few seconds.');
    }

    const botPermissions = voiceChannel.permissionsFor(botMember);
    if (!botPermissions?.has(PermissionFlagsBits.Connect)) {
      throw new Error(`Greenroom cannot join ${voiceChannel.name}. Give the bot Connect permission in that voice channel.`);
    }
    if (!botPermissions.has(PermissionFlagsBits.Speak)) {
      throw new Error(`Greenroom cannot speak in ${voiceChannel.name}. Give the bot Speak permission in that voice channel.`);
    }

    const userPermissions = voiceChannel.permissionsFor(member);
    if (!userPermissions?.has(PermissionFlagsBits.Connect)) {
      throw new Error(`You do not have Connect permission for ${voiceChannel.name}. Join a voice channel you can access.`);
    }
  }

  private destroyTrackedConnection(guildId: string): void {
    const tracked = getVoiceConnection(guildId);
    if (tracked && tracked !== this.voiceConnection) {
      try {
        tracked.destroy();
      } catch {
        // best-effort stale connection cleanup
      }
    }
  }

  private async connectWithRetry(voiceChannel: VoiceBasedChannel, guild: Guild, attempts = VOICE_CONNECT_ATTEMPTS): Promise<VoiceConnection> {
    let lastError: Error | undefined;
    this.destroyTrackedConnection(guild.id);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });
      const logStateChange = (oldState: { status: string }, newState: { status: string }): void => {
        if (oldState.status !== newState.status) {
          console.log(`[VoiceConnection] attempt ${attempt}/${attempts}: ${oldState.status} -> ${newState.status}`);
        }
      };
      const logError = (error: Error): void => {
        console.error(`[VoiceConnection] attempt ${attempt}/${attempts} error:`, error.message);
      };
      connection.on('stateChange', logStateChange);
      connection.on('error', logError);
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
        connection.off('stateChange', logStateChange);
        connection.off('error', logError);
        console.log(`[VoiceConnection] Ready (attempt ${attempt}/${attempts}).`);
        return connection;
      } catch (err) {
        lastError = err as Error;
        console.warn(`[VoiceConnection] Attempt ${attempt}/${attempts} failed: ${lastError.message}; final state=${connection.state.status}`);
        connection.off('stateChange', logStateChange);
        connection.off('error', logError);
        try {
          connection.destroy();
        } catch {
          // ignore
        }
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw new Error(readableVoiceConnectError(lastError));
  }

  async routeSpotifyAudioForUser(spotifyUserId: string): Promise<string> {
    const targetDevice = this.spotify.getUserAudioDevice(spotifyUserId) ?? this.config.audioDevice;
    await this.routeSpotifyAudio(targetDevice, true);
    return targetDevice;
  }

  async startCapture(spotifyUserId: string): Promise<CaptureHandle> {
    const targetDevice = this.spotify.getUserAudioDevice(spotifyUserId) ?? this.config.audioDevice;
    await this.routeSpotifyAudioForUser(spotifyUserId);
    const handle = this.audioEngine.start(targetDevice, this.activeEffects);
    this.audioPlayer.play(handle.resource);
    this.activeSpotifyUserId = spotifyUserId;
    return handle;
  }

  async ensureVoiceConnection(member: GuildMember, guild: Guild, spotifyUserId: string, startAudio = true): Promise<VoiceBasedChannel> {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error('You must be in a voice channel to use this command!');
    }
    this.assertCanUseVoiceChannel(member, voiceChannel, guild);

    const healthy =
      this.voiceConnection !== null &&
      this.currentChannelId === voiceChannel.id &&
      this.voiceConnection.state.status === VoiceConnectionStatus.Ready;

    if (healthy) {
      if (startAudio && !this.audioEngine.isActive()) await this.startCapture(spotifyUserId);
      return voiceChannel;
    }

    if (this.voiceConnection) {
      try {
        this.voiceConnection.destroy();
      } catch {
        // ignore stale cleanup
      }
      this.voiceConnection = null;
    }

    this.voiceConnection = await this.connectWithRetry(voiceChannel, guild);
    this.currentChannelId = voiceChannel.id;
    this.currentChannelName = voiceChannel.name;
    this.currentGuildName = guild.name;
    this.attachConnectionLifecycle(this.voiceConnection);
    this.voiceConnection.subscribe(this.audioPlayer);

    await this.maximizeBitrate(voiceChannel, guild);

    this.activeEffects = { bassboost: false, speed: 1.0 };
    if (startAudio) await this.startCapture(spotifyUserId);

    return voiceChannel;
  }

  async reapplyCapture(spotifyUserId: string): Promise<void> {
    if (!this.voiceConnection || !this.isActive()) {
      throw new Error('The bot must be active in a voice channel to apply live audio effects!');
    }
    const { readyPromise } = await this.startCapture(spotifyUserId);
    await readyPromise;
  }

  handleVoiceStateUpdate(oldState: VoiceState, _newState: VoiceState): void {
    if (!this.voiceConnection || !this.currentChannelId) return;

    const guild = oldState.guild;
    const channel = guild.channels.cache.get(this.currentChannelId);
    if (!channel || !channel.isVoiceBased()) return;

    const humanUsers = channel.members.filter((m) => !m.user.bot).size;

    if (humanUsers === 0) {
      if (!this.autoDisconnectTimer) {
        console.log(`[Bot] ${channel.name} is empty. Starting 45s auto-disconnect timer.`);
        this.autoDisconnectTimer = setTimeout(() => {
          console.log(`[Bot] ${channel.name} empty timeout. Leaving.`);
          this.cleanup();
        }, EMPTY_CHANNEL_TIMEOUT_MS);
      }
    } else if (this.autoDisconnectTimer) {
      console.log(`[Bot] A user rejoined ${channel.name}. Cancelling auto-disconnect.`);
      clearTimeout(this.autoDisconnectTimer);
      this.autoDisconnectTimer = null;
    }
  }
}

export const createVoiceSessionManager = (deps: VoiceSessionDeps): VoiceSessionManager => new VoiceSessionManager(deps);
