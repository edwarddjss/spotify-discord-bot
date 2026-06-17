import type { AudioRouteResult } from '@greenroom/engine/windows-audio-router';
import { restoreSpotifyOutput, routeSpotifyToCapture } from '@greenroom/engine/windows-audio-router';
import { DEFAULT_CAPTURE_DEVICE } from '@greenroom/shared';
import { dataDir } from './paths';
import { loadAudioSettings } from './vault';

export async function routeSpotifyOutputFromDesktop(): Promise<AudioRouteResult> {
  const audio = loadAudioSettings();
  const result = await routeSpotifyToCapture(audio.captureDevice || DEFAULT_CAPTURE_DEVICE, {
    dataDir: dataDir(),
    ...(audio.routeDevice ? { routeDeviceName: audio.routeDevice } : {}),
  });
  if (result.ok) {
    if (!result.skipped) console.log(`[AudioRouting] ${result.message}`);
  } else {
    console.warn(`[AudioRouting] Could not route Spotify audio from desktop: ${result.message}`);
  }
  return result;
}

export async function restoreSpotifyOutputFromDesktop(): Promise<AudioRouteResult> {
  const audio = loadAudioSettings();
  const result = await restoreSpotifyOutput(audio.captureDevice || DEFAULT_CAPTURE_DEVICE, {
    dataDir: dataDir(),
    ...(audio.restoreDevice ? { restoreDeviceName: audio.restoreDevice } : {}),
  });
  if (result.ok) {
    if (!result.skipped) console.log(`[AudioRouting] ${result.message}`);
  } else {
    console.warn(`[AudioRouting] Could not restore Spotify audio from desktop: ${result.message}`);
  }
  return result;
}
