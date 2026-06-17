import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import { config } from './config.js';
import { emitHealth } from './health.js';
import { normalizeFfmpegCaptureDevice } from './audio-device-names.js';
import type { AudioEffects } from './types.js';

const DEFAULT_EFFECTS: AudioEffects = { bassboost: false, speed: 1.0 };
const CAPTURE_READY_TIMEOUT_MS = 8_000;
const CAPTURE_MIN_PEAK = 500;
const FFMPEG_ERROR_PATTERN = /\b(error|failed|cannot|invalid|unavailable|not found|no such|permission denied|access denied)\b/i;

export interface CaptureHandle {
  resource: AudioResource;
  readyPromise: Promise<void>;
}

class AudioCaptureEngine {
  private ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private audioResource: AudioResource | null = null;

  /** Spawn FFmpeg on a device with live effects and return the playable resource. */
  start(deviceName: string | null = null, effects: AudioEffects = DEFAULT_EFFECTS): CaptureHandle {
    const oldProcess = this.ffmpegProcess;
    if (oldProcess) {
      console.log('[AudioEngine] Stopping old capture to release the device lock.');
      oldProcess.removeAllListeners();
      try {
        oldProcess.stdout.destroy();
        oldProcess.stderr.destroy();
      } catch {
        // best-effort
      }
      oldProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }

    const platform = config.audioPlatform;
    const device = normalizeFfmpegCaptureDevice(deviceName ?? config.audioDevice);

    // Ultra-low-latency resample + volume, with optional bass/atempo effects.
    let filterChain = 'aresample=48000:async=1,volume=0.95';
    if (effects.bassboost) filterChain += ',bass=g=8';
    if (effects.speed !== 1.0) filterChain += `,atempo=${effects.speed}`;

    console.log(`[AudioEngine] Spawning FFmpeg on ${platform}, device "${device}", effects:`, effects);

    let ffmpegArgs: string[];
    if (platform === 'windows') {
      ffmpegArgs = [
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-rtbufsize', '150M',
        '-thread_queue_size', '2048',
        '-audio_buffer_size', '10',
        '-f', 'dshow',
        '-i', `audio=${device}`,
        '-af', filterChain,
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-ac', '2',
        '-f', 's16le',
        'pipe:1',
      ];
    } else {
      ffmpegArgs = [
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-thread_queue_size', '1024',
        '-f', 'pulse',
        '-i', device,
        '-af', filterChain,
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-ac', '2',
        '-f', 's16le',
        'pipe:1',
      ];
    }

    try {
      const newProcess = spawn(config.ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      newProcess.on('error', (err: NodeJS.ErrnoException) => {
        console.error('[AudioEngine] FFmpeg process error:', err.message);
        if (err.code === 'ENOENT') {
          console.error('\x1b[31m[Error] FFmpeg was not found. Set FFMPEG_PATH or add it to PATH.\x1b[0m');
        }
      });

      newProcess.stderr.on('data', (data: Buffer) => {
        const importantLines = data
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && FFMPEG_ERROR_PATTERN.test(line));
        if (importantLines.length > 0) {
          console.warn(`[AudioEngine FFmpeg] ${importantLines.join('\n')}`);
        }
      });

      newProcess.on('close', (code: number | null) => {
        console.log(`[AudioEngine] FFmpeg exited with code ${code}`);
        if (this.ffmpegProcess === newProcess) {
          this.ffmpegProcess = null;
          this.audioResource = null;
        }
      });

      const passThrough = new PassThrough();
      newProcess.stdout.pipe(passThrough);

      const readyPromise = new Promise<void>((resolve, reject) => {
        let resolved = false;
        let peak = 0;
        const finish = (err?: Error): void => {
          if (resolved) return;
          resolved = true;
          if (err) reject(err);
          else resolve();
        };
        passThrough.on('data', (chunk: Buffer) => {
          for (let i = 0; i + 1 < chunk.length; i += 2) {
            const sample = Math.abs(chunk.readInt16LE(i));
            if (sample > peak) peak = sample;
          }
          if (peak >= CAPTURE_MIN_PEAK) {
            console.log(`[AudioEngine] Capture stream is producing audio (peak=${peak}).`);
            emitHealth('ffmpeg_ready', { device });
            finish();
          }
        });
        setTimeout(() => {
          if (resolved) return;
          if (peak >= CAPTURE_MIN_PEAK) {
            console.log(`[AudioEngine] Capture stream is producing audio (peak=${peak}).`);
            emitHealth('ffmpeg_ready', { device });
            finish();
            return;
          }
          finish(
            new Error(
              `No audio detected on "${device}" after ${CAPTURE_READY_TIMEOUT_MS / 1000}s. ` +
                'Make sure Spotify is playing, Windows routed it to CABLE Input, and nothing else is using CABLE Output.',
            ),
          );
        }, CAPTURE_READY_TIMEOUT_MS);
      });

      this.ffmpegProcess = newProcess;
      this.audioResource = createAudioResource(passThrough, { inputType: StreamType.Raw });

      console.log('[AudioEngine] Capture stream initialized.');
      return { resource: this.audioResource, readyPromise };
    } catch (error) {
      console.error('[AudioEngine] Failed to spawn FFmpeg:', (error as Error).message);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.ffmpegProcess) {
      console.log('[AudioEngine] Terminating FFmpeg capture...');
      this.ffmpegProcess.removeAllListeners();
      try {
        this.ffmpegProcess.stdout.destroy();
        this.ffmpegProcess.stderr.destroy();
      } catch {
        // best-effort
      }
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }
    this.audioResource = null;
  }

  isActive(): boolean {
    return this.ffmpegProcess !== null;
  }
}

export const audioEngine = new AudioCaptureEngine();
export type { AudioCaptureEngine };
