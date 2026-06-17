import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present. dotenv never overrides existing process.env, so the
// Electron supervisor's injected credentials always win over any stray .env.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const requiredEnv = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
] as const;

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.warn(`\x1b[33m[Warning] Missing environment variables: ${missing.join(', ')}\x1b[0m`);
}

// Writable data directory. In a packaged Electron build the engine dir lives in a
// read-only asar, so the supervisor points GREENROOM_DATA_DIR at app userData.
const dataDir = process.env.GREENROOM_DATA_DIR ?? process.env.SPOTICORD_DATA_DIR ?? process.env.SONICORD_DATA_DIR ?? path.join(__dirname, '..');

export interface GreenroomConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  publicAuthBaseUrl: string;
  port: number;
  audioPlatform: 'windows' | 'linux';
  audioDevice: string;
  /** Windows playback endpoint Spotify is routed to while streaming (CABLE Input). */
  spotifyOutputDevice: string;
  /** Windows endpoint Spotify returns to after streaming (Speakers/headphones). */
  spotifyRestoreDevice: string;
  spotifyTargetDeviceName: string;
  /** Absolute path (or PATH name) of the FFmpeg binary; bundled in production. */
  ffmpegPath: string;
  /** Base64 32-byte AES key for the at-rest credential store; null = plaintext. */
  storeKey: string | null;
  dataDir: string;
  authStorePath: string;
  memoryStorePath: string;
  /** Embedded NLU model: absolute path to the GGUF (downloaded on first run). */
  nluModelPath: string;
  /** Source URL for the embedded NLU model, used by the first-run downloader. */
  nluModelUrl: string;
  /** Master switch for the local LLM NLU; rule-based parser is always the fallback. */
  nluEnabled: boolean;
}

const DEFAULT_NLU_MODEL_FILE = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf';
const DEFAULT_NLU_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf';

const platform = (process.env.AUDIO_PLATFORM ?? (process.platform === 'win32' ? 'windows' : 'linux')).toLowerCase();
const publicAuthBaseUrl = (
  process.env.GREENROOM_PUBLIC_AUTH_BASE_URL ??
  process.env.SPOTICORD_PUBLIC_AUTH_BASE_URL ??
  process.env.SONICORD_PUBLIC_AUTH_BASE_URL ??
  ''
).replace(/\/+$/, '');

export const config: GreenroomConfig = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
  discordGuildId: process.env.DISCORD_GUILD_ID ?? '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
  publicAuthBaseUrl,
  spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI ?? (publicAuthBaseUrl ? `${publicAuthBaseUrl}/callback` : 'http://localhost:8888/callback'),
  port: Number.parseInt(process.env.PORT ?? '8888', 10),
  audioPlatform: platform === 'windows' ? 'windows' : 'linux',
  audioDevice: process.env.AUDIO_DEVICE ?? 'CABLE Output (VB-Audio Virtual Cable)',
  spotifyOutputDevice:
    process.env.GREENROOM_SPOTIFY_OUTPUT_DEVICE ??
    process.env.SPOTICORD_SPOTIFY_OUTPUT_DEVICE ??
    process.env.SONICORD_SPOTIFY_OUTPUT_DEVICE ??
    '',
  spotifyRestoreDevice:
    process.env.GREENROOM_SPOTIFY_RESTORE_DEVICE ??
    process.env.SPOTICORD_SPOTIFY_RESTORE_DEVICE ??
    process.env.SONICORD_SPOTIFY_RESTORE_DEVICE ??
    '',
  spotifyTargetDeviceName: process.env.SPOTIFY_TARGET_DEVICE_NAME ?? '',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  storeKey: process.env.GREENROOM_STORE_KEY ?? process.env.SPOTICORD_STORE_KEY ?? process.env.SONICORD_STORE_KEY ?? null,
  dataDir,
  authStorePath: path.join(dataDir, 'spotify-auth.json'),
  memoryStorePath: path.join(dataDir, 'memory.json'),
  nluModelPath:
    process.env.GREENROOM_NLU_MODEL ??
    process.env.SPOTICORD_NLU_MODEL ??
    process.env.SONICORD_NLU_MODEL ??
    path.join(dataDir, 'models', DEFAULT_NLU_MODEL_FILE),
  nluModelUrl: process.env.GREENROOM_NLU_MODEL_URL ?? process.env.SPOTICORD_NLU_MODEL_URL ?? process.env.SONICORD_NLU_MODEL_URL ?? DEFAULT_NLU_MODEL_URL,
  nluEnabled: (process.env.GREENROOM_NLU_ENABLED ?? process.env.SPOTICORD_NLU_ENABLED ?? process.env.SONICORD_NLU_ENABLED) !== 'false',
};
