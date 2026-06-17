import { toEngineEnv, type AudioDeviceSettings, type EngineCredentials } from '@greenroom/shared';
import { dataDir, ffmpegPath, modelPath } from './paths';
import { getStoreKey, loadAudioSettings } from './vault';

/**
 * Build the env for a forked engine/register child. We MUST inherit the parent
 * env (PATH, and on Windows SystemRoot/SystemDrive - without them getaddrinfo
 * fails with EAI_FAIL) and then layer our injected credentials/config on top.
 * ELECTRON_RUN_AS_NODE is stripped so the child behaves as plain Node.
 */
export function buildEngineEnv(creds: EngineCredentials, resolvedAudio?: AudioDeviceSettings): Record<string, string> {
  const env: Record<string, string> = {};
  const saved = loadAudioSettings();
  const audio = resolvedAudio ?? saved;
  const runtimeOptions = {
    dataDir: dataDir(),
    ffmpegPath: ffmpegPath(),
    storeKey: getStoreKey(),
    nluModelPath: modelPath(),
    ...(audio.captureDevice ? { audioDevice: audio.captureDevice } : {}),
    ...(audio.routeDevice ? { spotifyOutputDevice: audio.routeDevice } : {}),
    ...(audio.restoreDevice ? { spotifyRestoreDevice: audio.restoreDevice } : {}),
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, toEngineEnv(creds, runtimeOptions));
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
