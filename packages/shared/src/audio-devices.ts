/** Windows MMDevices registry name for routing Spotify playback to VB-Cable. */
export const DEFAULT_ROUTE_DEVICE = 'CABLE Input';

/** DirectShow / FFmpeg capture endpoint for VB-Cable loopback. */
export const DEFAULT_CAPTURE_DEVICE = 'CABLE Output (VB-Audio Virtual Cable)';

/**
 * Normalize a VB-Cable playback device name for the Windows per-app router.
 * Registry names are often short ("CABLE Input") while UI defaults include
 * the VB-Audio suffix that the router cannot substring-match on its own.
 */
export function normalizeRouterDeviceName(name: string): string {
  const trimmed = name.trim();
  if (/^CABLE Input(?:\s*\([^)]*\))?$/i.test(trimmed)) return DEFAULT_ROUTE_DEVICE;
  return trimmed.replace(/\s*\(VB-Audio[^)]*\)\s*/gi, '').trim();
}

/**
 * Map a registry capture label to the DirectShow name FFmpeg expects.
 * Registry: "CABLE Output" — DirectShow: "CABLE Output (VB-Audio Virtual Cable)".
 */
export function normalizeFfmpegCaptureDevice(name: string): string {
  const trimmed = name.trim();
  if (/^CABLE Output$/i.test(trimmed)) return DEFAULT_CAPTURE_DEVICE;
  return trimmed;
}

/** Derive the VB-Cable playback endpoint from a capture device label. */
export function playbackDeviceFromCapture(captureDeviceName: string): string {
  return normalizeRouterDeviceName(
    captureDeviceName.replace(/CABLE Output(\s*\([^)]*\))?/i, 'CABLE Input$1'),
  );
}
