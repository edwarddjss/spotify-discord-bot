import express, { type Express } from 'express';
import type { Server } from 'node:http';
import fetch from 'node-fetch';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { loadJson, saveJson } from './store.js';
import { emitHealth } from './health.js';
import { extractSpotifyReference, normalizeSpotifySearchQuery } from './spotify-utils.js';
import type {
  PlaybackState,
  PlayResult,
  ProfileStore,
  SpotifyDevice,
} from './types.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface DevicesResponse {
  devices?: SpotifyDevice[];
}

interface SpotifyOwner {
  id: string;
  display_name?: string;
}

interface SpotifyPlaylist {
  uri: string;
  name: string;
  owner?: SpotifyOwner;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
}

interface PlaylistTrackItem {
  track?: SpotifyTrack | null;
}

interface SearchResponse {
  playlists?: { items?: (SpotifyPlaylist | null)[] };
  tracks?: { items?: (SpotifyTrack | null)[] };
}

interface PlaylistsResponse {
  items?: (SpotifyPlaylist | null)[];
}

interface PlaylistTracksResponse {
  items?: PlaylistTrackItem[];
  next?: string | null;
}

interface PlayerStateResponse {
  is_playing: boolean;
  progress_ms?: number | null;
  item?: {
    uri?: string;
    name: string;
    duration_ms?: number;
    artists: { name: string }[];
    album: { name: string; images?: { url: string; width?: number; height?: number }[] };
    external_urls: { spotify: string };
  } | null;
  device?: { name: string; type: string; volume_percent: number; id: string | null } | null;
}

const MAX_PLAYLIST_QUEUE_TRACKS = 50;

export class SpotifyController extends EventEmitter {
  profiles: ProfileStore = {};
  private expressServer: Server | null = null;

  constructor() {
    super();
    this.loadCredentials();
  }

  private loadCredentials(): void {
    try {
      this.profiles = loadJson<ProfileStore>(config.authStorePath, config.storeKey, {});
      const count = Object.keys(this.profiles).length;
      console.log(`[Spotify] Loaded ${count} user profile(s) from local storage.`);
    } catch (error) {
      console.error('[Spotify] Failed to load credentials:', (error as Error).message);
    }
  }

  private saveCredentials(): void {
    try {
      saveJson(config.authStorePath, config.storeKey, this.profiles);
    } catch (error) {
      console.error('[Spotify] Failed to save credentials:', (error as Error).message);
    }
  }

  isUserAuthenticated(discordUserId: string): boolean {
    return Boolean(this.profiles[discordUserId]?.refreshToken);
  }

  getUserAudioDevice(discordUserId: string): string | null {
    return this.profiles[discordUserId]?.audioDevice ?? null;
  }

  setUserAudioDevice(discordUserId: string, deviceName: string): boolean {
    const profile = this.profiles[discordUserId];
    if (!profile) return false;
    profile.audioDevice = deviceName;
    this.saveCredentials();
    return true;
  }

  startAuthServer(): void {
    if (this.expressServer) return;
    const app: Express = express();

    app.get('/login', (req, res) => {
      const discordUserId = typeof req.query.state === 'string' ? req.query.state : '';
      if (!discordUserId) {
        res.status(400).send('Error: Missing state (discordUserId). Request the link via /login in Discord.');
        return;
      }
      const scopes = ['user-modify-playback-state', 'user-read-playback-state', 'user-read-currently-playing', 'playlist-read-private'].join(' ');
      const authUrl =
        'https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: config.spotifyClientId,
          scope: scopes,
          redirect_uri: config.spotifyRedirectUri,
          state: discordUserId,
        }).toString();
      res.redirect(authUrl);
    });

    app.get('/callback', (req, res) => {
      void (async () => {
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const discordUserId = typeof req.query.state === 'string' ? req.query.state : '';
        if (!code) {
          res.status(400).send('Error: Missing authorization code.');
          return;
        }
        if (!discordUserId) {
          res.status(400).send('Error: Missing state (discordUserId).');
          return;
        }
        try {
          const tokens = await this.exchangeCode(code);
          const existing = this.profiles[discordUserId];
          this.profiles[discordUserId] = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            audioDevice: existing?.audioDevice ?? null,
          };
          this.saveCredentials();
          emitHealth('spotify_auth_saved', { discordUserId });
          res.send(
            `<html><body style="font-family:Arial;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#121212;color:#fff;">
              <h1 style="color:#1DB954;">Spotify Authorized</h1>
              <p>Your Spotify account is linked. You can close this tab and return to Discord.</p>
            </body></html>`,
          );
          console.log(`[Spotify] Authorization successful for Discord user ${discordUserId}`);
          this.emit('authenticated', discordUserId);
        } catch (err) {
          console.error('[Spotify] Token exchange failed:', (err as Error).message);
          res.status(500).send(`Authentication failed: ${(err as Error).message}`);
        }
      })();
    });

    const server = app.listen(config.port, () => {
      console.log(`[Spotify] Auth server listening on port ${config.port}`);
      console.log(`[Spotify] Login links use ${config.publicAuthBaseUrl || `http://localhost:${config.port}`}`);
      console.log(`[Spotify] Redirect URI is ${config.spotifyRedirectUri}`);
      emitHealth('auth_server_listening', { port: config.port });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      this.expressServer = null;
      if (err.code === 'EADDRINUSE') {
        console.error(
          `\x1b[31m[Spotify] Port ${config.port} is already in use. Stop the other instance or change PORT - Spotify /login cannot work until the auth server binds.\x1b[0m`,
        );
      } else {
        console.error('[Spotify] Auth server error:', err.message);
      }
      emitHealth('engine_error', { scope: 'auth_server', code: err.code ?? 'unknown', message: err.message });
    });

    this.expressServer = server;
  }

  stopAuthServer(): void {
    if (this.expressServer) {
      this.expressServer.close();
      this.expressServer = null;
      console.log('[Spotify] Auth server stopped.');
    }
  }

  getLoginUrl(discordUserId: string): string {
    const baseUrl = config.publicAuthBaseUrl || `http://localhost:${config.port}`;
    return `${baseUrl}/login?state=${encodeURIComponent(discordUserId)}`;
  }

  private async exchangeCode(code: string): Promise<TokenResponse> {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.spotifyRedirectUri,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Spotify token error: ${response.status} - ${await response.text()}`);
    }
    return (await response.json()) as TokenResponse;
  }

  private async getAccessToken(discordUserId: string): Promise<string> {
    const profile = this.profiles[discordUserId];
    if (!profile) throw new Error('User profile not registered with Spotify. Run /login first.');
    if (!profile.accessToken || Date.now() > profile.expiresAt - 30000) {
      if (!profile.refreshToken) throw new Error('No refresh token for this profile. User must authenticate.');
      await this.refreshAccessToken(discordUserId);
    }
    return this.profiles[discordUserId]!.accessToken;
  }

  private async refreshAccessToken(discordUserId: string): Promise<void> {
    const profile = this.profiles[discordUserId];
    if (!profile?.refreshToken) throw new Error('No refresh token available.');
    console.log(`[Spotify] Refreshing access token for ${discordUserId}...`);
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: profile.refreshToken }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Spotify token refresh error: ${response.status} - ${await response.text()}`);
    }
    const text = await response.text();
    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error(
        `Spotify token refresh returned a non-JSON response. Run /login in Discord to relink Spotify. Body starts with: ${text.slice(0, 80)}`,
      );
    }
    profile.accessToken = data.access_token;
    profile.expiresAt = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) profile.refreshToken = data.refresh_token;
    this.saveCredentials();
    console.log(`[Spotify] Token refreshed for ${discordUserId}`);
  }

  private async readSpotifyResponse<T>(response: Awaited<ReturnType<typeof fetch>>, context: string): Promise<T | null> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      let parsed = text;
      try {
        const json = JSON.parse(text) as { error?: { message?: string } };
        parsed = json.error?.message ?? text;
      } catch {
        // not JSON
      }
      throw new Error(`Spotify Web API ${context} failed (${response.status}): ${parsed.slice(0, 240)}`);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      const hint = /^[A-Za-z0-9+/=]{8,}$/.test(text.trim())
        ? ' The response looked like corrupted credentials — run /login in Discord to relink Spotify.'
        : '';
      throw new Error(
        `Spotify Web API ${context} returned a non-JSON response (HTTP ${response.status}).${hint} Body starts with: ${text.slice(0, 80)}`,
      );
    }
  }

  async request<T = unknown>(discordUserId: string, endpoint: string, method: HttpMethod = 'GET', body: unknown = null): Promise<T | null> {
    const token = await this.getAccessToken(discordUserId);
    const url = `https://api.spotify.com/v1${endpoint}`;
    const options = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    };

    let response = await fetch(url, options);
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '2', 10);
      console.log(`[Spotify] Rate limited. Retrying after ${retryAfter}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      response = await fetch(url, options);
    }
    return this.readSpotifyResponse<T>(response, `${method} ${endpoint}`);
  }

  async getDevices(discordUserId: string): Promise<SpotifyDevice[]> {
    const data = await this.request<DevicesResponse>(discordUserId, '/me/player/devices', 'GET');
    return data?.devices ?? [];
  }

  async findTargetDevice(discordUserId: string): Promise<SpotifyDevice | null> {
    const devices = await this.getDevices(discordUserId);
    if (devices.length === 0) return null;
    if (config.spotifyTargetDeviceName) {
      const target = config.spotifyTargetDeviceName.toLowerCase();
      const match = devices.find((d) => d.name.toLowerCase().includes(target));
      if (match) return match;
    }
    const computer = devices.find((d) => d.type.toLowerCase() === 'computer');
    if (computer) return computer;
    const active = devices.find((d) => d.is_active);
    if (active) return active;
    return devices[0] ?? null;
  }

  async play(discordUserId: string, deviceId: string | null = null): Promise<PlayResult> {
    const deviceParam = deviceId ? `?device_id=${deviceId}` : '';
    try {
      // Resume playback with no body — Spotify rejects `{}` and may return a non-JSON error.
      await this.request(discordUserId, `/me/player/play${deviceParam}`, 'PUT');
      return { success: true, message: 'Spotify resumed. Ensure Spotify is active on your host client.' };
    } catch (error) {
      if ((error as Error).message.includes('Restriction violated')) {
        const state = await this.getPlaybackState(discordUserId).catch(() => null);
        if (state?.isPlaying) return { success: true, message: 'Spotify is already playing.' };
        return { success: true, message: 'Spotify is already active.' };
      }
      throw new Error(`Could not start playback. Make sure your Spotify desktop client is running: ${(error as Error).message}`);
    }
  }

  /**
   * Resume playback on the desktop Spotify device after Windows per-app routing
   * has changed. Spotify can keep an existing render session pinned to the old
   * output until playback is restarted on that client, so transfer first, pause
   * briefly, then play on the same device.
   */
  async resumeOnRoutedDevice(discordUserId: string, deviceId: string | null = null): Promise<PlayResult> {
    try {
      if (deviceId) {
        await this.transferPlayback(discordUserId, deviceId, true);
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          await this.pause(discordUserId, deviceId);
          await new Promise((resolve) => setTimeout(resolve, 350));
        } catch (err) {
          console.warn('[AudioRouting] Could not pause Spotify to rebind its output device:', (err as Error).message);
        }
        return await this.play(discordUserId, deviceId);
      }

      const state = await this.getPlaybackState(discordUserId).catch(() => null);
      if (state?.isPlaying) {
        await this.pause(discordUserId).catch((err) => {
          console.warn('[AudioRouting] Could not pause Spotify to rebind its output device:', (err as Error).message);
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return await this.play(discordUserId);
    } catch (err) {
      console.warn('[AudioRouting] Spotify playback control failed after routing (continuing with capture):', (err as Error).message);
      return { success: true, message: 'Windows audio routed; Spotify playback control skipped.' };
    }
  }

  async searchAndPlay(discordUserId: string, query: string): Promise<PlayResult> {
    const cleanQuery = normalizeSpotifySearchQuery(query);
    console.log(`[Spotify] Searching "${cleanQuery}" for ${discordUserId}...`);
    const isPlaylistQuery = /\b(music|playlist|mix|genre|chill|vibes|party|rap|rock|edm|house|garage|pop|lofi)\b/i.test(cleanQuery);
    const searchType = isPlaylistQuery ? 'playlist,track' : 'track';

    const searchResult = await this.request<SearchResponse>(
      discordUserId,
      `/search?q=${encodeURIComponent(cleanQuery)}&type=${searchType}&limit=1`,
      'GET',
    );
    if (!searchResult) throw new Error('No search results found.');

    const playlist = searchResult.playlists?.items?.find((item): item is SpotifyPlaylist => item !== null);
    const track = searchResult.tracks?.items?.find((item): item is SpotifyTrack => item !== null);

    let playBody: Record<string, unknown>;
    let matchName: string;
    let matchType: string;
    if (playlist) {
      playBody = { context_uri: playlist.uri };
      matchName = playlist.name;
      matchType = 'playlist';
    } else if (track) {
      playBody = { uris: [track.uri] };
      matchName = `${track.name} by ${track.artists.map((a) => a.name).join(', ')}`;
      matchType = 'track';
    } else {
      throw new Error('No tracks or playlists found matching that query.');
    }

    const device = await this.findTargetDevice(discordUserId);
    const deviceParam = device?.id ? `?device_id=${device.id}` : '';
    await this.request(discordUserId, `/me/player/play${deviceParam}`, 'PUT', playBody);
    return { success: true, matchName, matchType, deviceName: device?.name ?? 'Active Host Client' };
  }

  async queueTrack(discordUserId: string, queryOrLink: string): Promise<PlayResult> {
    const directReference = extractSpotifyReference(queryOrLink);
    let trackUri: string;
    let matchName: string;

    if (directReference) {
      if (directReference.type === 'playlist') {
        return this.queuePlaylist(discordUserId, directReference.id);
      }
      if (directReference.type !== 'track') throw new Error('Queueing supports track and playlist links only.');
      trackUri = directReference.uri;
      matchName = `Spotify Link (${directReference.type})`;
    } else {
      const cleanQuery = normalizeSpotifySearchQuery(queryOrLink);
      const searchResult = await this.request<SearchResponse>(
        discordUserId,
        `/search?q=${encodeURIComponent(cleanQuery)}&type=track&limit=1`,
        'GET',
      );
      const track = searchResult?.tracks?.items?.find((item): item is SpotifyTrack => item !== null);
      if (!track) throw new Error('No tracks found matching that query.');
      trackUri = track.uri;
      matchName = `${track.name} by ${track.artists.map((a) => a.name).join(', ')}`;
    }

    const device = await this.findTargetDevice(discordUserId);
    await this.queueUri(discordUserId, trackUri, device?.id ?? null);
    return { success: true, matchName, matchType: 'track', deviceName: device?.name ?? 'Active Host Client' };
  }

  private async queueUri(discordUserId: string, uri: string, deviceId: string | null): Promise<void> {
    const queueParams = new URLSearchParams({ uri });
    if (deviceId) queueParams.set('device_id', deviceId);
    await this.request(discordUserId, `/me/player/queue?${queueParams.toString()}`, 'POST');
  }

  private async queuePlaylist(discordUserId: string, playlistId: string): Promise<PlayResult> {
    const playlist = await this.request<{ name?: string }>(discordUserId, `/playlists/${playlistId}?fields=name`, 'GET').catch(() => null);
    const device = await this.findTargetDevice(discordUserId);
    const deviceId = device?.id ?? null;

    let offset = 0;
    let queuedCount = 0;
    let skippedCount = 0;
    while (queuedCount < MAX_PLAYLIST_QUEUE_TRACKS) {
      const limit = Math.min(100, MAX_PLAYLIST_QUEUE_TRACKS - queuedCount);
      const response = await this.request<PlaylistTracksResponse>(
        discordUserId,
        `/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=items(track(uri,name,artists(name))),next`,
        'GET',
      );
      const items = response?.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        const uri = item.track?.uri;
        if (!uri) {
          skippedCount += 1;
          continue;
        }
        await this.queueUri(discordUserId, uri, deviceId);
        queuedCount += 1;
        if (queuedCount >= MAX_PLAYLIST_QUEUE_TRACKS) break;
      }
      if (!response?.next || items.length < limit) break;
      offset += items.length;
    }

    if (queuedCount === 0) throw new Error('No playable tracks found in that playlist.');
    return {
      success: true,
      matchName: playlist?.name ?? 'Spotify playlist',
      matchType: 'playlist',
      deviceName: device?.name ?? 'Active Host Client',
      queuedCount,
      skippedCount,
      message:
        queuedCount >= MAX_PLAYLIST_QUEUE_TRACKS
          ? `Queued the first ${queuedCount} playable tracks.`
          : `Queued ${queuedCount} playable track${queuedCount === 1 ? '' : 's'}.`,
    };
  }

  async clearQueue(discordUserId: string): Promise<PlayResult> {
    const state = await this.request<PlayerStateResponse>(discordUserId, '/me/player', 'GET');
    const currentUri = state?.item?.uri;
    if (!currentUri) {
      return { success: true, matchName: 'Spotify queue', message: 'Spotify is not currently playing anything.' };
    }
    const device = await this.findTargetDevice(discordUserId);
    const deviceParam = device?.id ? `?device_id=${device.id}` : '';
    await this.request(discordUserId, `/me/player/play${deviceParam}`, 'PUT', {
      uris: [currentUri],
      position_ms: state?.progress_ms ?? 0,
    });
    return {
      success: true,
      matchName: 'Spotify queue',
      deviceName: device?.name ?? 'Active Host Client',
      message: 'Asked Spotify to replace the pending queue with the current track.',
    };
  }

  async resolveUserDisplayName(discordUserId: string, displayName: string): Promise<{ spotifyUserId: string; spotifyDisplayName: string }> {
    const cleanName = displayName.trim();
    try {
      const searchResult = await this.request<SearchResponse>(
        discordUserId,
        `/search?q=${encodeURIComponent(cleanName)}&type=playlist&limit=10`,
        'GET',
      );
      const items = searchResult?.playlists?.items ?? [];
      const match = items.find((item): item is SpotifyPlaylist => {
        if (!item?.owner) return false;
        const ownerName = (item.owner.display_name ?? '').toLowerCase();
        return ownerName.includes(cleanName.toLowerCase()) || cleanName.toLowerCase().includes(ownerName);
      });
      if (match?.owner) {
        return { spotifyUserId: match.owner.id, spotifyDisplayName: match.owner.display_name ?? cleanName };
      }
    } catch (err) {
      console.warn('[Spotify] Display name resolution failed:', (err as Error).message);
    }
    return { spotifyUserId: displayName.toLowerCase().replace(/\s+/g, ''), spotifyDisplayName: displayName };
  }

  async playUserPlaylist(discordUserId: string, spotifyUserId: string, playlistSearchQuery: string): Promise<{ success: boolean; playlistName: string; deviceName: string }> {
    const response = await this.request<PlaylistsResponse>(discordUserId, `/users/${spotifyUserId}/playlists?limit=50`, 'GET');
    const items = response?.items ?? [];
    if (items.length === 0) throw new Error('This user has no public playlists visible on Spotify.');

    const cleanSearch = playlistSearchQuery.toLowerCase().trim();
    let selected: SpotifyPlaylist | null = null;
    if (/\b(playlist|mix|vibe|music|song|track)\b/i.test(cleanSearch) && cleanSearch.split(' ').length === 1) {
      selected = items.find((item): item is SpotifyPlaylist => item !== null) ?? null;
    } else {
      selected = items.find((item): item is SpotifyPlaylist => item !== null && item.name.toLowerCase().includes(cleanSearch)) ?? null;
    }
    selected ??= items.find((item): item is SpotifyPlaylist => item !== null) ?? null;
    if (!selected) throw new Error('Could not find a playable playlist for this user.');

    const device = await this.findTargetDevice(discordUserId);
    const deviceParam = device?.id ? `?device_id=${device.id}` : '';
    await this.request(discordUserId, `/me/player/play${deviceParam}`, 'PUT', { context_uri: selected.uri });
    return { success: true, playlistName: selected.name, deviceName: device?.name ?? 'Active Host Client' };
  }

  async pause(discordUserId: string, deviceId: string | null = null): Promise<void> {
    const deviceParam = deviceId ? `?device_id=${deviceId}` : '';
    await this.request(discordUserId, `/me/player/pause${deviceParam}`, 'PUT');
  }

  async next(discordUserId: string, deviceId: string | null = null): Promise<void> {
    const deviceParam = deviceId ? `?device_id=${deviceId}` : '';
    await this.request(discordUserId, `/me/player/next${deviceParam}`, 'POST');
  }

  async transferPlayback(discordUserId: string, deviceId: string, play = true): Promise<void> {
    await this.request(discordUserId, '/me/player', 'PUT', { device_ids: [deviceId], play });
  }

  async getPlaybackState(discordUserId: string): Promise<PlaybackState> {
    try {
      const state = await this.request<PlayerStateResponse>(discordUserId, '/me/player', 'GET');
      if (!state) return { isPlaying: false, track: null };
      const item = state.item;
      return {
        isPlaying: state.is_playing,
        ...(typeof state.progress_ms === 'number' ? { progressMs: state.progress_ms } : {}),
        track: item
          ? {
              name: item.name,
              artists: item.artists.map((a) => a.name).join(', '),
              album: item.album.name,
              url: item.external_urls.spotify,
              // Spotify returns images largest-first; the first is the 640px cover.
              ...(item.album.images?.[0]?.url ? { albumArtUrl: item.album.images[0].url } : {}),
              ...(typeof item.duration_ms === 'number' ? { durationMs: item.duration_ms } : {}),
            }
          : null,
        device: state.device
          ? { name: state.device.name, type: state.device.type, volume: state.device.volume_percent, id: state.device.id }
          : null,
      };
    } catch (err) {
      console.error(`[Spotify] Failed to get playback state for ${discordUserId}:`, (err as Error).message);
      return { isPlaying: false, track: null, error: (err as Error).message };
    }
  }
}

export const spotify = new SpotifyController();
