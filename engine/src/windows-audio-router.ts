import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRouterDeviceName, playbackDeviceFromCapture } from './audio-device-names.js';

export interface AudioRouteResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
}

export interface AudioRouterOptions {
  dataDir?: string;
  routeDeviceName?: string;
  restoreDeviceName?: string;
}

const ROUTE_TIMEOUT_MS = 8_000;

const ROUTER_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][ValidateSet('route','restore')] [string] $Action,
  [Parameter(Mandatory=$true)] [string] $TargetName,
  [Parameter(Mandatory=$true)] [string] $StatePath
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Greenroom {
  public enum DataFlow { Render = 0, Capture = 1, All = 2 }
  public enum Role { Console = 0, Multimedia = 1, Communications = 2 }
  public enum DeviceState { Active = 0x00000001 }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
    public int p2;
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject {}

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig]
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, [MarshalAs(UnmanagedType.Interface)] out IMMDeviceCollection ppDevices);
    [PreserveSig]
    int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice ppEndpoint);
    [PreserveSig]
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, [MarshalAs(UnmanagedType.Interface)] out IMMDevice ppDevice);
    [PreserveSig]
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    [PreserveSig]
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }

  [ComImport]
  [Guid("0BD7A1BE-7A1A-44DB-8397-C0B320963D88")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    [PreserveSig]
    int GetCount(out uint pcDevices);
    [PreserveSig]
    int Item(uint nDevice, [MarshalAs(UnmanagedType.Interface)] out IMMDevice ppDevice);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig]
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    [PreserveSig]
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    [PreserveSig]
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    [PreserveSig]
    int GetState(out DeviceState pdwState);
  }

  [ComImport]
  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig]
    int GetCount(out uint cProps);
    [PreserveSig]
    int GetAt(uint iProp, out PropertyKey pkey);
    [PreserveSig]
    int GetValue(ref PropertyKey key, out PropVariant pv);
    [PreserveSig]
    int SetValue(ref PropertyKey key, ref PropVariant propvar);
    [PreserveSig]
    int Commit();
  }

  [ComImport]
  [Guid("ab3d4648-e242-459f-b02f-541c70306324")]
  [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  public interface IAudioPolicyConfigFactoryVariantFor21H2 {
    int __incomplete__add_CtxVolumeChange();
    int __incomplete__remove_CtxVolumeChanged();
    int __incomplete__add_RingerVibrateStateChanged();
    int __incomplete__remove_RingerVibrateStateChange();
    int __incomplete__SetVolumeGroupGainForId();
    int __incomplete__GetVolumeGroupGainForId();
    int __incomplete__GetActiveVolumeGroupForEndpointId();
    int __incomplete__GetVolumeGroupsForEndpoint();
    int __incomplete__GetCurrentVolumeContext();
    int __incomplete__SetVolumeGroupMuteForId();
    int __incomplete__GetVolumeGroupMuteForId();
    int __incomplete__SetRingerVibrateState();
    int __incomplete__GetRingerVibrateState();
    int __incomplete__SetPreferredChatApplication();
    int __incomplete__ResetPreferredChatApplication();
    int __incomplete__GetPreferredChatApplication();
    int __incomplete__GetCurrentChatApplications();
    int __incomplete__add_ChatContextChanged();
    int __incomplete__remove_ChatContextChanged();
    [PreserveSig] uint SetPersistedDefaultAudioEndpoint(int processId, int flow, int role, [MarshalAs(UnmanagedType.HString)] string deviceId);
    [PreserveSig] uint GetPersistedDefaultAudioEndpoint(int processId, int flow, int role, [Out, MarshalAs(UnmanagedType.HString)] out string deviceId);
    [PreserveSig] uint ClearAllPersistedApplicationDefaultEndpoints();
  }

  [ComImport]
  [Guid("2a59116d-6c4f-45e0-a74f-707e3fef9258")]
  [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  public interface IAudioPolicyConfigFactoryVariantForDownlevel {
    int __incomplete__add_CtxVolumeChange();
    int __incomplete__remove_CtxVolumeChanged();
    int __incomplete__add_RingerVibrateStateChanged();
    int __incomplete__remove_RingerVibrateStateChange();
    int __incomplete__SetVolumeGroupGainForId();
    int __incomplete__GetVolumeGroupGainForId();
    int __incomplete__GetActiveVolumeGroupForEndpointId();
    int __incomplete__GetVolumeGroupsForEndpoint();
    int __incomplete__GetCurrentVolumeContext();
    int __incomplete__SetVolumeGroupMuteForId();
    int __incomplete__GetVolumeGroupMuteForId();
    int __incomplete__SetRingerVibrateState();
    int __incomplete__GetRingerVibrateState();
    int __incomplete__SetPreferredChatApplication();
    int __incomplete__ResetPreferredChatApplication();
    int __incomplete__GetPreferredChatApplication();
    int __incomplete__GetCurrentChatApplications();
    int __incomplete__add_ChatContextChanged();
    int __incomplete__remove_ChatContextChanged();
    [PreserveSig] uint SetPersistedDefaultAudioEndpoint(int processId, int flow, int role, [MarshalAs(UnmanagedType.HString)] string deviceId);
    [PreserveSig] uint GetPersistedDefaultAudioEndpoint(int processId, int flow, int role, [Out, MarshalAs(UnmanagedType.HString)] out string deviceId);
    [PreserveSig] uint ClearAllPersistedApplicationDefaultEndpoints();
  }

  public static class AudioRouter {
    private const string RenderInterfaceSuffix = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    private const string RenderDevicesKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
    private const string AppDefaultsKey = @"Software\Microsoft\Multimedia\Audio\DefaultEndpoint";

    [DllImport("combase.dll")]
    private static extern int RoInitialize(uint initType);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int RoGetActivationFactory(
      [MarshalAs(UnmanagedType.HString)] string activatableClassId,
      ref Guid iid,
      [MarshalAs(UnmanagedType.IInspectable)] out object factory);

    public static string Run(string action, string targetName, string statePath) {
      RoInitialize(1);

      Process[] spotify = Process.GetProcessesByName("Spotify");
      Array.Sort(spotify, delegate(Process a, Process b) {
        bool aWindow = !String.IsNullOrWhiteSpace(a.MainWindowTitle);
        bool bWindow = !String.IsNullOrWhiteSpace(b.MainWindowTitle);
        if (aWindow == bWindow) return a.Id.CompareTo(b.Id);
        return aWindow ? -1 : 1;
      });

      string deviceId;
      DeviceInfo targetDevice = null;
      if (action == "route") {
        targetDevice = FindRenderDevice(targetName);
        deviceId = targetDevice != null ? targetDevice.FullId : null;
        if (targetDevice == null || String.IsNullOrWhiteSpace(deviceId)) {
          throw new Exception("Could not find the virtual audio output device named " + targetName + ".");
        }

        DeviceInfo previousPreference = ReadSpotifyRegistryOutput();
        string previous = previousPreference != null ? SerializeDeviceInfo(previousPreference) : (spotify.Length > 0 ? GetPersistedEndpoint(spotify[0].Id) : null);
        if (!String.IsNullOrWhiteSpace(previous) && previous.StartsWith(deviceId, StringComparison.OrdinalIgnoreCase)) previous = null;
        if (String.IsNullOrWhiteSpace(previous)) previous = SerializeDeviceInfo(GetDefaultRenderDevice());
        Directory.CreateDirectory(Path.GetDirectoryName(statePath));
        File.WriteAllText(statePath, previous ?? "", Encoding.UTF8);
      } else {
        if (!String.IsNullOrWhiteSpace(targetName) && targetName != "__greenroom_previous__") {
          targetDevice = FindRenderDevice(targetName);
          if (targetDevice == null || String.IsNullOrWhiteSpace(targetDevice.FullId)) {
            throw new Exception("Could not find the restore audio output device named " + targetName + ".");
          }
        }
        if (targetDevice == null) {
          string state = File.Exists(statePath) ? File.ReadAllText(statePath, Encoding.UTF8).Trim() : "";
          targetDevice = DeserializeDeviceInfo(state);
        }
        if (targetDevice == null) targetDevice = GetDefaultRenderDevice();
        deviceId = targetDevice != null ? targetDevice.FullId : null;
      }

      if (String.IsNullOrWhiteSpace(deviceId)) {
        throw new Exception("Could not resolve the audio device to use.");
      }

      int processChanged = 0;
      string lastError = null;
      foreach (Process proc in spotify) {
        try {
          if (SetPersistedEndpoint(proc.Id, deviceId)) processChanged++;
        } catch (Exception ex) {
          lastError = ex.Message;
        }
      }

      int registryChanged = ApplySpotifyRegistryOutput(targetDevice);
      int verifiedProcesses = CountPersistedEndpointMatches(spotify, deviceId);
      bool registryVerified = IsSameDevice(ReadSpotifyRegistryOutput(), targetDevice);

      if (processChanged == 0 && registryChanged == 0) {
        if (spotify.Length == 0) return action == "route"
          ? "Spotify is not running, so audio routing was skipped."
          : "Spotify is not running, so audio restore was skipped.";
        throw new Exception(lastError ?? "Windows rejected the Spotify audio route.");
      }

      if (verifiedProcesses == 0 && !registryVerified) {
        throw new Exception("Windows accepted the Spotify audio route, but did not confirm the new output device.");
      }

      return action == "route"
        ? "Spotify audio is routed to Greenroom. " + RouteSummary(processChanged, registryChanged, verifiedProcesses, registryVerified)
        : "Spotify audio was restored. " + RouteSummary(processChanged, registryChanged, verifiedProcesses, registryVerified);
    }

    private static bool NameMatches(string friendlyName, string targetName) {
      if (String.IsNullOrWhiteSpace(friendlyName) || String.IsNullOrWhiteSpace(targetName)) return false;
      if (friendlyName.IndexOf(targetName, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      if (targetName.IndexOf(friendlyName, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      return false;
    }

    private static DeviceInfo FindRenderDevice(string containsName) {
      DeviceInfo fallback = null;
      using (RegistryKey render = Registry.LocalMachine.OpenSubKey(RenderDevicesKey)) {
        if (render == null) return null;
        foreach (string childName in render.GetSubKeyNames()) {
          using (RegistryKey device = render.OpenSubKey(childName))
          using (RegistryKey props = render.OpenSubKey(childName + @"\Properties")) {
            if (props == null) continue;
            string friendlyName =
              ReadRegistryString(props.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},2")) ??
              ReadRegistryString(props.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},14")) ??
              "";
            if (!NameMatches(friendlyName, containsName)) continue;

            DeviceInfo info = DeviceInfoFromRegistry(childName, props);
            if (IsActiveDevice(device)) return info;
            if (fallback == null) fallback = info;
          }
        }
      }
      return fallback;
    }

    private static DeviceInfo GetDefaultRenderDevice() {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      Check(enumerator.GetDefaultAudioEndpoint((int)DataFlow.Render, (int)Role.Multimedia, out device), "GetDefaultAudioEndpoint");
      string id;
      Check(device.GetId(out id), "GetDefaultDeviceId");
      DeviceInfo match = FindRenderDeviceByFullId(NormalizeRenderEndpointId(id));
      if (match != null) return match;
      return new DeviceInfo(NormalizeRenderEndpointId(id), null);
    }

    private static DeviceInfo FindRenderDeviceByFullId(string fullId) {
      using (RegistryKey render = Registry.LocalMachine.OpenSubKey(RenderDevicesKey)) {
        if (render == null) return null;
        foreach (string childName in render.GetSubKeyNames()) {
          using (RegistryKey props = render.OpenSubKey(childName + @"\Properties")) {
            if (props == null) continue;
            DeviceInfo info = DeviceInfoFromRegistry(childName, props);
            if (info != null && String.Equals(info.FullId, fullId, StringComparison.OrdinalIgnoreCase)) return info;
          }
        }
      }
      return null;
    }

    private static DeviceInfo DeviceInfoFromRegistry(string childName, RegistryKey props) {
      string endpointId = ReadRegistryString(props.GetValue("{9c119480-ddc2-4954-a150-5bd240d454ad},1"));
      if (String.IsNullOrWhiteSpace(endpointId)) {
        endpointId = ReadRegistryString(props.GetValue("{4b416b7d-8501-40c1-acfd-97aa9bdc17c8},1"));
      }
      if (String.IsNullOrWhiteSpace(endpointId)) endpointId = "{0.0.0.00000000}." + childName;
      string fullId = NormalizeRenderEndpointId(endpointId);
      string groupId = ReadRegistryString(props.GetValue("{9637b4b9-11ee-4c35-b43c-7b2452c993cc},1"));
      return new DeviceInfo(fullId, groupId);
    }

    private static bool IsActiveDevice(RegistryKey device) {
      if (device == null) return false;
      object raw = device.GetValue("DeviceState");
      if (raw == null) return true;
      try {
        return Convert.ToInt32(raw) == (int)DeviceState.Active;
      } catch {
        return true;
      }
    }

    private static string ReadRegistryString(object value) {
      if (value == null) return null;
      string asString = value as string;
      if (asString != null) return asString.Trim();
      string[] asStringArray = value as string[];
      if (asStringArray != null) return String.Join("", asStringArray).Trim();
      byte[] asBytes = value as byte[];
      if (asBytes != null) return Encoding.Unicode.GetString(asBytes).TrimEnd('\0').Trim();
      return value.ToString().Trim();
    }

    private static string NormalizeRenderEndpointId(string endpointId) {
      if (String.IsNullOrWhiteSpace(endpointId)) return endpointId;
      string trimmed = endpointId.Trim();
      if (trimmed.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return trimmed;
      return @"\\?\SWD#MMDEVAPI#" + trimmed + RenderInterfaceSuffix;
    }

    private static DeviceInfo ReadSpotifyRegistryOutput() {
      using (RegistryKey parent = Registry.CurrentUser.OpenSubKey(AppDefaultsKey, false)) {
        if (parent == null) return null;
        foreach (string childName in parent.GetSubKeyNames()) {
          using (RegistryKey appKey = parent.OpenSubKey(childName, false)) {
            if (appKey == null) continue;
            string app = ReadRegistryString(appKey.GetValue(""));
            if (app == null || app.IndexOf("Spotify", StringComparison.OrdinalIgnoreCase) < 0) continue;
            string fullId =
              ReadRegistryString(appKey.GetValue("001_000")) ??
              ReadRegistryString(appKey.GetValue("000_000")) ??
              ReadRegistryString(appKey.GetValue("002_000"));
            string groupId =
              ReadRegistryString(appKey.GetValue("001_000_p")) ??
              ReadRegistryString(appKey.GetValue("000_000_p")) ??
              ReadRegistryString(appKey.GetValue("002_000_p"));
            if (!String.IsNullOrWhiteSpace(fullId)) return new DeviceInfo(fullId, groupId);
          }
        }
      }
      return null;
    }

    private static int ApplySpotifyRegistryOutput(DeviceInfo device) {
      if (device == null || String.IsNullOrWhiteSpace(device.FullId)) return 0;
      int changed = 0;
      using (RegistryKey parent = Registry.CurrentUser.OpenSubKey(AppDefaultsKey, true)) {
        if (parent == null) return 0;
        foreach (string childName in parent.GetSubKeyNames()) {
          using (RegistryKey appKey = parent.OpenSubKey(childName, true)) {
            if (appKey == null) continue;
            string app = ReadRegistryString(appKey.GetValue(""));
            if (app == null || app.IndexOf("Spotify", StringComparison.OrdinalIgnoreCase) < 0) continue;
            appKey.SetValue("000_000", device.FullId, RegistryValueKind.String);
            appKey.SetValue("001_000", device.FullId, RegistryValueKind.String);
            appKey.SetValue("002_000", device.FullId, RegistryValueKind.String);
            if (!String.IsNullOrWhiteSpace(device.GroupId)) {
              appKey.SetValue("000_000_p", device.GroupId, RegistryValueKind.String);
              appKey.SetValue("001_000_p", device.GroupId, RegistryValueKind.String);
              appKey.SetValue("002_000_p", device.GroupId, RegistryValueKind.String);
            }
            changed++;
          }
        }
      }
      return changed;
    }

    private static int CountPersistedEndpointMatches(Process[] spotify, string deviceId) {
      int matches = 0;
      foreach (Process proc in spotify) {
        try {
          string persisted = GetPersistedEndpoint(proc.Id);
          if (!String.IsNullOrWhiteSpace(persisted) && String.Equals(NormalizeRenderEndpointId(persisted), NormalizeRenderEndpointId(deviceId), StringComparison.OrdinalIgnoreCase)) {
            matches++;
          }
        } catch {
          // best-effort verification
        }
      }
      return matches;
    }

    private static bool IsSameDevice(DeviceInfo current, DeviceInfo expected) {
      return current != null &&
        expected != null &&
        !String.IsNullOrWhiteSpace(current.FullId) &&
        !String.IsNullOrWhiteSpace(expected.FullId) &&
        String.Equals(NormalizeRenderEndpointId(current.FullId), NormalizeRenderEndpointId(expected.FullId), StringComparison.OrdinalIgnoreCase);
    }

    private static string RouteSummary(int processChanged, int registryChanged, int verifiedProcesses, bool registryVerified) {
      return "(Windows confirmed " + verifiedProcesses + " Spotify process route(s), app setting " + (registryVerified ? "updated" : "unchanged") + "; wrote " + processChanged + " process route(s), " + registryChanged + " app setting(s).)";
    }

    private static string SerializeDeviceInfo(DeviceInfo device) {
      if (device == null) return "";
      return (device.FullId ?? "") + "\n" + (device.GroupId ?? "");
    }

    private static DeviceInfo DeserializeDeviceInfo(string state) {
      if (String.IsNullOrWhiteSpace(state)) return null;
      string[] parts = state.Replace("\r\n", "\n").Split('\n');
      string fullId = parts.Length > 0 ? parts[0].Trim() : "";
      string groupId = parts.Length > 1 ? parts[1].Trim() : null;
      if (String.IsNullOrWhiteSpace(fullId)) return null;
      DeviceInfo known = FindRenderDeviceByFullId(NormalizeRenderEndpointId(fullId));
      return known ?? new DeviceInfo(NormalizeRenderEndpointId(fullId), groupId);
    }

    private static string GetPersistedEndpoint(int processId) {
      string multimedia = GetPersistedEndpointForRole(processId, Role.Multimedia);
      if (!String.IsNullOrWhiteSpace(multimedia)) return multimedia;
      string console = GetPersistedEndpointForRole(processId, Role.Console);
      if (!String.IsNullOrWhiteSpace(console)) return console;
      return GetPersistedEndpointForRole(processId, Role.Communications);
    }

    private static string GetPersistedEndpointForRole(int processId, Role role) {
      bool current;
      object factory = GetFactory(out current);
      string deviceId = null;
      uint hr = current
        ? ((IAudioPolicyConfigFactoryVariantFor21H2)factory).GetPersistedDefaultAudioEndpoint(processId, (int)DataFlow.Render, (int)role, out deviceId)
        : ((IAudioPolicyConfigFactoryVariantForDownlevel)factory).GetPersistedDefaultAudioEndpoint(processId, (int)DataFlow.Render, (int)role, out deviceId);
      return hr == 0 ? deviceId : null;
    }

    private static bool SetPersistedEndpoint(int processId, string deviceId) {
      bool current;
      object factory = GetFactory(out current);
      Role[] roles = new Role[] { Role.Console, Role.Multimedia, Role.Communications };
      foreach (Role role in roles) {
        uint hr = current
          ? ((IAudioPolicyConfigFactoryVariantFor21H2)factory).SetPersistedDefaultAudioEndpoint(processId, (int)DataFlow.Render, (int)role, deviceId)
          : ((IAudioPolicyConfigFactoryVariantForDownlevel)factory).SetPersistedDefaultAudioEndpoint(processId, (int)DataFlow.Render, (int)role, deviceId);
        Check(unchecked((int)hr), "SetPersistedDefaultAudioEndpoint");
      }
      return true;
    }

    private static object GetFactory(out bool current) {
      Guid iid = typeof(IAudioPolicyConfigFactoryVariantForDownlevel).GUID;
      object factory;
      int hr = RoGetActivationFactory("Windows.Media.Internal.AudioPolicyConfig", ref iid, out factory);
      if (hr == 0) {
        current = false;
        return factory;
      }

      iid = typeof(IAudioPolicyConfigFactoryVariantFor21H2).GUID;
      Check(RoGetActivationFactory("Windows.Media.Internal.AudioPolicyConfig", ref iid, out factory), "RoGetActivationFactory");
      current = true;
      return factory;
    }

    private static void Check(int hr, string where) {
      if (hr < 0) {
        Exception inner = Marshal.GetExceptionForHR(hr);
        throw new Exception(where + " failed with HRESULT 0x" + hr.ToString("X8") + ": " + (inner != null ? inner.Message : "Unknown error"));
      }
    }

    private sealed class DeviceInfo {
      public readonly string FullId;
      public readonly string GroupId;

      public DeviceInfo(string fullId, string groupId) {
        FullId = fullId;
        GroupId = groupId;
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[Greenroom.AudioRouter]::Run($Action, $TargetName, $StatePath)
`;

function isDisabled(): boolean {
  return (process.env.GREENROOM_AUDIO_ROUTING ?? '').toLowerCase() === 'false';
}

function restoreDeviceName(): string {
  return process.env.GREENROOM_SPOTIFY_RESTORE_DEVICE ?? process.env.SPOTICORD_SPOTIFY_RESTORE_DEVICE ?? '__greenroom_previous__';
}

function playbackDeviceName(captureDeviceName: string): string {
  const override = process.env.GREENROOM_SPOTIFY_OUTPUT_DEVICE ?? process.env.SPOTICORD_SPOTIFY_OUTPUT_DEVICE;
  if (override) return normalizeRouterDeviceName(override);
  return playbackDeviceFromCapture(captureDeviceName);
}

function resolvePlaybackDeviceName(captureDeviceName: string, options: AudioRouterOptions): string {
  const name = options.routeDeviceName ?? playbackDeviceName(captureDeviceName);
  return normalizeRouterDeviceName(name);
}

function resolveRestoreDeviceName(options: AudioRouterOptions): string {
  const name = options.restoreDeviceName ?? restoreDeviceName();
  return name === '__greenroom_previous__' ? name : normalizeRouterDeviceName(name);
}

function routerDataDir(options: AudioRouterOptions): string {
  return options.dataDir ?? process.env.GREENROOM_DATA_DIR ?? process.env.SPOTICORD_DATA_DIR ?? process.env.SONICORD_DATA_DIR ?? process.cwd();
}

function powershellPath(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

function scriptPath(dataDir: string): string {
  const dir = join(dataDir, 'runtime');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'greenroom-audio-router.ps1');
  writeFileSync(file, ROUTER_SCRIPT, 'utf8');
  return file;
}

function runRouter(action: 'route' | 'restore', captureDeviceName: string, options: AudioRouterOptions = {}): Promise<AudioRouteResult> {
  if (isDisabled()) {
    return Promise.resolve({ ok: true, skipped: true, message: 'Automatic Spotify audio routing is disabled.' });
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true, skipped: true, message: 'Automatic Spotify audio routing is only available on Windows.' });
  }

  const dataDir = routerDataDir(options);
  const statePath = join(dataDir, 'runtime', 'spotify-output-device.txt');
  const child = spawn(
    powershellPath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath(dataDir),
      '-Action',
      action,
      '-TargetName',
      action === 'route' ? resolvePlaybackDeviceName(captureDeviceName, options) : resolveRestoreDeviceName(options),
      '-StatePath',
      statePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: AudioRouteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: 'Windows did not finish changing Spotify audio output in time.' });
    }, ROUTE_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer) => (stdout += data.toString('utf8')));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf8')));
    child.on('error', (err) => finish({ ok: false, message: err.message }));
    child.on('exit', (code) => {
      const message = summarizeRouterOutput(stdout.trim() || stderr.trim());
      const skipped = /was skipped|routing is disabled|only available on Windows/i.test(message);
      if (code === 0) finish({ ok: true, skipped, message: message || 'Spotify audio route updated.' });
      else finish({ ok: false, message: message || `Spotify audio route failed with exit code ${code ?? 'unknown'}.` });
    });
  });
}

function summarizeRouterOutput(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('At '));
  if (!line) return '';
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

export async function routeSpotifyToCapture(captureDeviceName: string, options: AudioRouterOptions = {}): Promise<AudioRouteResult> {
  return runRouter('route', captureDeviceName, options);
}

export async function restoreSpotifyOutput(captureDeviceName: string, options: AudioRouterOptions = {}): Promise<AudioRouteResult> {
  return runRouter('restore', captureDeviceName, options);
}
