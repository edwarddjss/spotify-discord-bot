import { spawn } from 'node:child_process';
import type { AudioDeviceChoice, AudioDeviceReport } from '@greenroom/shared';
import { DEFAULT_CAPTURE_DEVICE, DEFAULT_ROUTE_DEVICE, normalizeFfmpegCaptureDevice } from '@greenroom/shared';
import { loadAudioSettings } from './vault';

const DEFAULT_CAPTURE_DEVICE_LEGACY = DEFAULT_CAPTURE_DEVICE;
const DEFAULT_ROUTE_DEVICE_LEGACY = DEFAULT_ROUTE_DEVICE;

interface PsDevice {
  id?: string;
  name?: string;
  kind?: 'render' | 'capture';
  state?: number;
}

function isVirtualCable(name: string): boolean {
  return /\bVB(?:-Audio)?\b|VB-Audio Virtual Cable|\bCABLE(?:[-\s]?[A-D])?\b|CABLE\s+(Input|Output|In|Out)/i.test(name);
}

function runPowerShell(script: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve('');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

function normalizeChoice(raw: PsDevice): AudioDeviceChoice | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const kind = raw.kind === 'render' || raw.kind === 'capture' ? raw.kind : null;
  if (!name || !kind) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${kind}:${name}`,
    name,
    kind,
    isVirtualCable: isVirtualCable(name),
  };
}

function uniqueByName(devices: AudioDeviceChoice[]): AudioDeviceChoice[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    const key = `${device.kind}:${device.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanWindowsDevices(): Promise<{ render: AudioDeviceChoice[]; capture: AudioDeviceChoice[] }> {
  if (process.platform !== 'win32') return { render: [], capture: [] };

  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
function Read-FriendlyName($props) {
  $name = $props.GetValue('{a45c254e-df1c-4efd-8020-67d146a850e0},2')
  if (-not $name) { $name = $props.GetValue('{a45c254e-df1c-4efd-8020-67d146a850e0},14') }
  if ($name -is [byte[]]) { $name = [Text.Encoding]::Unicode.GetString($name).Trim([char]0).Trim() }
  if ($name -is [string[]]) { $name = ($name -join '').Trim() }
  if ($name) { [string]$name } else { $null }
}
function Read-Devices($kind, $key) {
  $items = @()
  $root = Get-Item $key
  if (-not $root) { return $items }
  foreach ($child in $root.GetSubKeyNames()) {
    $device = $root.OpenSubKey($child)
    $props = $root.OpenSubKey("$child\Properties")
    if (-not $device -or -not $props) { continue }
    $state = $device.GetValue('DeviceState')
    if ($state -and [int]$state -ne 1) { continue }
    $name = Read-FriendlyName $props
    if (-not $name) { continue }
    $items += [pscustomobject]@{ id = $child; name = $name; kind = $kind; state = $state }
  }
  $items
}
$all = @()
$all += Read-Devices 'render' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$all += Read-Devices 'capture' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
$all | ConvertTo-Json -Depth 3
`;

  const stdout = await runPowerShell(script);
  try {
    const parsed = JSON.parse(stdout.trim() || '[]') as PsDevice[] | PsDevice;
    const raw = Array.isArray(parsed) ? parsed : [parsed];
    const devices = uniqueByName(raw.map(normalizeChoice).filter((item): item is AudioDeviceChoice => Boolean(item)));
    return {
      render: devices.filter((device) => device.kind === 'render'),
      capture: devices.filter((device) => device.kind === 'capture'),
    };
  } catch {
    return { render: [], capture: [] };
  }
}

function pickDevice(devices: AudioDeviceChoice[], matcher: RegExp): string {
  return devices.find((device) => matcher.test(device.name))?.name ?? '';
}

function pickRestoreDevice(render: AudioDeviceChoice[], routeDevice: string): string {
  return (
    render.find((device) => !device.isVirtualCable && device.name !== routeDevice)?.name ??
    ''
  );
}

export async function getAudioDeviceReport(): Promise<AudioDeviceReport> {
  const { render, capture } = await scanWindowsDevices();
  const saved = loadAudioSettings();
  const routeDevice = saved.routeDevice || pickDevice(render, /CABLE (Input|In)\b|VB-Audio Virtual Cable/i) || DEFAULT_ROUTE_DEVICE_LEGACY;
  const captureDevice = normalizeFfmpegCaptureDevice(
    saved.captureDevice || pickDevice(capture, /CABLE (Output|Out)\b|VB-Audio Virtual Cable/i) || DEFAULT_CAPTURE_DEVICE_LEGACY,
  );
  const savedRestoreDevice = saved.restoreDevice && !isVirtualCable(saved.restoreDevice) ? saved.restoreDevice : '';
  const restoreDevice = savedRestoreDevice || pickRestoreDevice(render, routeDevice);

  return {
    render,
    capture,
    settings: { captureDevice, routeDevice, restoreDevice },
  };
}
