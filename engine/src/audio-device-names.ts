/** Windows MMDevices registry name for routing Spotify playback to VB-Cable. */
export const DEFAULT_ROUTE_DEVICE = 'CABLE Input';

/** DirectShow / FFmpeg capture endpoint for VB-Cable loopback. */
export const DEFAULT_CAPTURE_DEVICE = 'CABLE Output (VB-Audio Virtual Cable)';

export function normalizeRouterDeviceName(name: string): string {
  const trimmed = name.trim();
  if (/^CABLE Input(?:\s*\([^)]*\))?$/i.test(trimmed)) return DEFAULT_ROUTE_DEVICE;
  return trimmed.replace(/\s*\(VB-Audio[^)]*\)\s*/gi, '').trim();
}

export function normalizeFfmpegCaptureDevice(name: string): string {
  const trimmed = name.trim();
  if (/^CABLE Output$/i.test(trimmed)) return DEFAULT_CAPTURE_DEVICE;
  return trimmed;
}

export function playbackDeviceFromCapture(captureDeviceName: string): string {
  return normalizeRouterDeviceName(
    captureDeviceName.replace(/CABLE Output(\s*\([^)]*\))?/i, 'CABLE Input$1'),
  );
}
