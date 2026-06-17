import { utilityProcess, type UtilityProcess } from 'electron';
import {
  EngineCredentials,
  EMPTY_PREREQS,
  type EngineSnapshot,
  type EngineState,
  type HealthEventName,
  type LogLine,
  type NowPlaying,
  type PrereqReport,
} from '@greenroom/shared';
import { HEALTH_MARKER } from '@greenroom/engine/health';
import { engineEntry } from './paths';
import { loadCreds } from './vault';
import { buildEngineEnv } from './engine-env';
import { getAudioDeviceReport } from './audio-devices';
import { restoreSpotifyOutputFromDesktop } from './audio-routing';

interface SupervisorCallbacks {
  onState: (snapshot: EngineSnapshot) => void;
  onLog: (lines: LogLine[]) => void;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_RESTART_ATTEMPTS = 5;
const HEALTHY_RESET_MS = 60_000;
const READY_WATCHDOG_MS = 20_000;
const LOG_RING_SIZE = 1000;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export class Supervisor {
  private child: UtilityProcess | null = null;
  private state: EngineState = 'idle';
  private lastError: string | undefined;
  private spotifyLinked = false;
  private captureActive = false;
  private nowPlaying: NowPlaying | null = null;
  private guildName: string | undefined;
  private channelName: string | undefined;
  private prereqs: PrereqReport = { ...EMPTY_PREREQS };

  private discordReady = false;
  private authServerReady = false;
  private userStopped = false;
  private restartAttempts = 0;
  private backoffTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private restartBlockedReason: string | undefined;

  private readonly logRing: LogLine[] = [];
  private redactList: string[] = [];

  constructor(private readonly cb: SupervisorCallbacks) {}

  snapshot(): EngineSnapshot {
    const snap: EngineSnapshot = {
      state: this.state,
      prereqs: this.prereqs,
      spotifyLinked: this.spotifyLinked,
      captureActive: this.captureActive,
      nowPlaying: this.nowPlaying,
    };
    if (this.lastError) snap.lastError = this.lastError;
    if (this.guildName) snap.guildName = this.guildName;
    if (this.channelName) snap.channelName = this.channelName;
    return snap;
  }

  setPrereqs(report: PrereqReport): void {
    this.prereqs = report;
    this.emit();
  }

  recentLogs(): LogLine[] {
    return [...this.logRing];
  }

  async start(): Promise<EngineSnapshot> {
    if (this.child) return this.snapshot();

    const parsed = EngineCredentials.safeParse(loadCreds());
    if (!parsed.success) {
      this.state = 'idle';
      this.lastError = 'Credentials incomplete - finish onboarding first.';
      this.emit();
      return this.snapshot();
    }

    this.userStopped = false;
    this.restartBlockedReason = undefined;
    this.discordReady = false;
    this.authServerReady = false;
    this.transition('starting');

    const creds = parsed.data;
    this.redactList = [creds.discordToken, creds.spotifyClientSecret].filter(Boolean);

    const audioReport = await getAudioDeviceReport();
    const env = buildEngineEnv(creds, audioReport.settings);

    const child = utilityProcess.fork(engineEntry(), [], { stdio: 'pipe', env });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk, 'info'));
    child.stderr?.on('data', (chunk: Buffer) => this.ingest(chunk, 'warn'));
    child.on('exit', (code) => this.onExit(code));

    this.watchdog = setTimeout(() => {
      if (this.state === 'starting') {
        this.lastError = 'Engine did not become ready within 20s.';
        this.transition('crashed');
        this.killChild();
        this.scheduleRestart();
      }
    }, READY_WATCHDOG_MS);

    this.emit();
    return this.snapshot();
  }

  async stop(): Promise<EngineSnapshot> {
    this.userStopped = true;
    this.clearTimers();
    this.transition('stopping');
    const restore = await restoreSpotifyOutputFromDesktop().catch(
      (err: unknown): { ok: boolean; message: string } => ({ ok: false, message: (err as Error)?.message ?? 'Unknown error.' }),
    );
    if (!restore.ok) {
      this.emitRoutingLog(`[AudioRouting] Could not restore Spotify audio: ${restore.message}`);
    }
    this.killChild();
    this.captureActive = false;
    this.clearNowPlaying();
    this.transition('idle');
    return this.snapshot();
  }

  async restart(): Promise<EngineSnapshot> {
    await this.stop();
    return this.start();
  }

  // ----- internals -----

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // best-effort
      }
      this.child = null;
    }
  }

  private onExit(code: number | undefined): void {
    this.child = null;
    this.captureActive = false;
    this.clearNowPlaying();
    if (this.userStopped) {
      this.transition('idle');
      return;
    }
    this.lastError = this.restartBlockedReason ?? `Engine exited (code ${code ?? 'unknown'}).`;
    this.transition('crashed');
    if (this.restartBlockedReason) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.lastError = `Engine failed ${MAX_RESTART_ATTEMPTS} times. Stopped retrying - check the logs.`;
      this.emit();
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    this.backoffTimer = setTimeout(() => void this.start(), delay);
  }

  private maybeRunning(): void {
    if (this.discordReady && this.authServerReady && this.state === 'starting') {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.transition('running');
      // Reset the failure counter once we've been healthy for a while.
      this.healthyTimer = setTimeout(() => {
        this.restartAttempts = 0;
      }, HEALTHY_RESET_MS);
    }
  }

  private handleHealth(event: HealthEventName, data: Record<string, unknown> | undefined): void {
    switch (event) {
      case 'auth_server_listening':
        this.authServerReady = true;
        this.maybeRunning();
        break;
      case 'discord_ready':
        this.discordReady = true;
        this.maybeRunning();
        break;
      case 'ffmpeg_ready':
      case 'voice_ready':
        this.captureActive = true;
        this.emit();
        break;
      case 'voice_stopped':
        this.captureActive = false;
        this.clearNowPlaying();
        this.emit();
        break;
      case 'now_playing':
        this.nowPlaying = parseNowPlaying(data);
        this.guildName = typeof data?.guildName === 'string' ? data.guildName : undefined;
        this.channelName = typeof data?.channelName === 'string' ? data.channelName : undefined;
        this.emit();
        break;
      case 'spotify_profiles_loaded':
        this.spotifyLinked = typeof data?.count === 'number' && data.count > 0;
        this.emit();
        break;
      case 'spotify_auth_saved':
        this.spotifyLinked = true;
        this.emit();
        break;
      case 'engine_error':
        this.lastError = typeof data?.message === 'string' ? data.message : 'Engine reported an error.';
        if (this.state === 'running') this.transition('degraded');
        else this.emit();
        break;
    }
  }

  private ingest(chunk: Buffer, level: LogLine['level']): void {
    const lines = chunk.toString('utf8').split('\n');
    const batch: LogLine[] = [];
    for (const raw of lines) {
      const line = raw.replace(ANSI_ESCAPE_PATTERN, '').trimEnd();
      if (!line) continue;
      if (/discord login failed:.*used disallowed intents/i.test(line)) {
        this.restartBlockedReason =
          'Enable Message Content Intent in the Discord Developer Portal, then start the bot again.';
      }

      const markerIdx = line.indexOf(HEALTH_MARKER);
      if (markerIdx !== -1) {
        try {
          const json = JSON.parse(line.slice(markerIdx + HEALTH_MARKER.length).trim()) as {
            event: HealthEventName;
            data?: Record<string, unknown>;
          };
          this.handleHealth(json.event, json.data);
        } catch {
          // not a valid health event; fall through and log it
        }
        continue;
      }

      const entry: LogLine = { ts: Date.now(), level, text: this.redact(line) };
      this.logRing.push(entry);
      if (this.logRing.length > LOG_RING_SIZE) this.logRing.shift();
      batch.push(entry);
    }
    if (batch.length > 0) this.cb.onLog(batch);
  }

  /**
   * Push a synthetic log line into the same channel the engine child uses, so
   * main-process audio-routing outcomes reach the renderer activity feed (which
   * already turns `[AudioRouting] ...` lines into friendly status messages).
   */
  private emitRoutingLog(text: string): void {
    const entry: LogLine = { ts: Date.now(), level: 'warn', text: this.redact(text) };
    this.logRing.push(entry);
    if (this.logRing.length > LOG_RING_SIZE) this.logRing.shift();
    this.cb.onLog([entry]);
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.redactList) {
      if (secret) out = out.split(secret).join('••••redacted••••');
    }
    out = out.replace(/(Bearer|Bot)\s+[\w.\-]{8,}/g, '$1 ••••');
    return out;
  }

  private transition(state: EngineState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.cb.onState(this.snapshot());
  }

  private clearNowPlaying(): void {
    this.nowPlaying = null;
    this.guildName = undefined;
    this.channelName = undefined;
  }

  private clearTimers(): void {
    for (const t of [this.backoffTimer, this.watchdog, this.healthyTimer]) {
      if (t) clearTimeout(t);
    }
    this.backoffTimer = null;
    this.watchdog = null;
    this.healthyTimer = null;
  }
}

/** Coerce a `now_playing` health payload into a typed NowPlaying, or null when cleared/malformed. */
function parseNowPlaying(data: Record<string, unknown> | undefined): NowPlaying | null {
  if (!data || data.track === null) return null;
  if (typeof data.title !== 'string' || typeof data.artist !== 'string') return null;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const playing: NowPlaying = {
    title: data.title,
    artist: data.artist,
    isPlaying: data.isPlaying === true,
    sampledAt: num(data.sampledAt) ?? Date.now(),
  };
  if (typeof data.albumArtUrl === 'string') playing.albumArtUrl = data.albumArtUrl;
  const progress = num(data.progressMs);
  if (progress !== undefined) playing.progressMs = progress;
  const duration = num(data.durationMs);
  if (duration !== undefined) playing.durationMs = duration;
  return playing;
}
