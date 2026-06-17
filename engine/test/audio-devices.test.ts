import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CAPTURE_DEVICE,
  DEFAULT_ROUTE_DEVICE,
  normalizeFfmpegCaptureDevice,
  normalizeRouterDeviceName,
  playbackDeviceFromCapture,
} from '../src/audio-device-names.js';

describe('audio device name normalization', () => {
  it('maps registry CABLE Input labels to the router name', () => {
    assert.equal(normalizeRouterDeviceName('CABLE Input (VB-Audio Virtual Cable)'), DEFAULT_ROUTE_DEVICE);
    assert.equal(normalizeRouterDeviceName('CABLE Input'), DEFAULT_ROUTE_DEVICE);
  });

  it('maps registry CABLE Output to the DirectShow capture name', () => {
    assert.equal(normalizeFfmpegCaptureDevice('CABLE Output'), DEFAULT_CAPTURE_DEVICE);
    assert.equal(normalizeFfmpegCaptureDevice(DEFAULT_CAPTURE_DEVICE), DEFAULT_CAPTURE_DEVICE);
  });

  it('derives playback routing from capture labels', () => {
    assert.equal(playbackDeviceFromCapture('CABLE Output (VB-Audio Virtual Cable)'), DEFAULT_ROUTE_DEVICE);
    assert.equal(playbackDeviceFromCapture('CABLE Output'), DEFAULT_ROUTE_DEVICE);
  });
});
