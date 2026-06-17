import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AudioDeviceReport,
  AudioDeviceSettings,
  DiscordValidation,
  PrereqReport,
  SpotifyValidation,
  TunnelStatus,
  VbCableInstallResult,
} from '@greenroom/shared';
import { EMPTY_PREREQS, botInviteUrl } from '@greenroom/shared';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { AudioRoutingPanel, isAudioRoutingReady } from './AudioRoutingPanel';
import { Button, Card, Code, Field, Modal, Pill, ProgressBar } from './ui';

type StepId = 'welcome' | 'vbcable' | 'routing' | 'discord' | 'spotify' | 'commands' | 'invite' | 'model' | 'finish';
const ORDER: StepId[] = ['welcome', 'vbcable', 'routing', 'discord', 'spotify', 'commands', 'invite', 'model', 'finish'];
const WIZARD_STEP_KEY = 'greenroom:onboarding-step';
const TITLES: Record<StepId, string> = {
  welcome: 'Welcome',
  vbcable: 'Audio cable',
  routing: 'Route Spotify',
  discord: 'Discord bot',
  spotify: 'Spotify app',
  commands: 'Commands',
  invite: 'Invite bot',
  model: 'Local AI model',
  finish: 'Prove it works',
};

type GuideId = 'discord' | 'spotify' | 'routing' | 'vbcable';

// Resolve bundled /public assets relative to the document so they work both in
// dev (served over http) and in the packaged app (loaded from file://, where an
// absolute "/guides/..." path would point at the filesystem root). electron-vite
// sets BASE_URL to "./" for the renderer build and "/" in dev.
const guideAsset = (file: string): string => `${import.meta.env.BASE_URL}guides/${file}`;

interface Guide {
  title: string;
  summary: string;
  primaryLabel: string;
  primaryUrl: string;
  videoSrc?: string;
  posterSrc?: string;
  steps: string[];
}

const GUIDES: Record<GuideId, Guide> = {
  discord: {
    title: 'Discord bot setup',
    summary: 'Create the application, add a bot, enable Message Content Intent, then copy the bot token and Application ID.',
    primaryLabel: 'Open Discord Developer Portal',
    primaryUrl: 'https://discord.com/developers/applications',
    videoSrc: guideAsset('discord-bot.webm'),
    posterSrc: guideAsset('discord-bot-poster.jpg'),
    steps: [
      'Create a new application.',
      'Open General Information and copy the Application ID.',
      'Open Bot, then reset or copy the bot token.',
      'Enable Message Content Intent under Privileged Gateway Intents.',
    ],
  },
  spotify: {
    title: 'Spotify app setup',
    summary: 'Create or open a Spotify developer app, add the exact redirect URI from greenroom, then copy the Client ID and Client Secret.',
    primaryLabel: 'Open Spotify Dashboard',
    primaryUrl: 'https://developer.spotify.com/dashboard',
    videoSrc: guideAsset('spotify-app.webm'),
    posterSrc: guideAsset('spotify-app-poster.jpg'),
    steps: [
      'Create a Spotify app, or open the greenroom app if you already made one.',
      'Copy the Client ID and reveal the Client Secret.',
      'Open app settings.',
      'Paste the redirect URI shown in greenroom, including /callback.',
      'Click Add, save the Spotify app, then paste the Client ID and Client Secret into greenroom.',
    ],
  },
  routing: {
    title: 'Route Spotify audio',
    summary: 'Fallback only: greenroom normally routes Spotify for you while the bot is streaming.',
    primaryLabel: 'Open Windows volume mixer',
    primaryUrl: 'ms-settings:apps-volume',
    steps: [
      'Open Windows Volume Mixer.',
      'Find Spotify in the app list.',
      'Set Spotify output to CABLE Input (VB-Audio Virtual Cable).',
      'Leave system output on your headphones or speakers.',
    ],
  },
  vbcable: {
    title: 'Install VB-Cable',
    summary: 'VB-Cable creates the virtual audio path used to capture Spotify from the host PC.',
    primaryLabel: 'Open VB-Cable download page',
    primaryUrl: 'https://vb-audio.com/Cable/',
    steps: [
      'Download VB-Cable from VB-Audio.',
      'Run the installer as administrator.',
      'Restart Windows if the installer asks.',
      'Reopen greenroom and re-check this step.',
    ],
  },
};

export function Wizard({ onDone }: { onDone: () => void }): JSX.Element {
  const [stepIdx, setStepIdx] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem(WIZARD_STEP_KEY) ?? '', 10);
    return Number.isInteger(saved) && saved >= 0 && saved < ORDER.length ? saved : 0;
  });
  const step = ORDER[stepIdx] ?? 'welcome';

  const [prereqs, setPrereqs] = useState<PrereqReport>(EMPTY_PREREQS);
  const [scanning, setScanning] = useState(false);
  const [installingCable, setInstallingCable] = useState(false);
  const [cableInstallResult, setCableInstallResult] = useState<VbCableInstallResult | null>(null);

  const [discordToken, setDiscordToken] = useState('');
  const [discordClientId, setDiscordClientId] = useState('');
  const [discordResult, setDiscordResult] = useState<DiscordValidation | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);

  const [spotifyClientId, setSpotifyClientId] = useState('');
  const [spotifyClientSecret, setSpotifyClientSecret] = useState('');
  const [spotifyResult, setSpotifyResult] = useState<SpotifyValidation | null>(null);
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelStatus>({ running: false });
  const [tunnelBusy, setTunnelBusy] = useState(false);

  const [audioReport, setAudioReport] = useState<AudioDeviceReport | null>(null);
  const [audioSaving, setAudioSaving] = useState(false);
  const [commandResult, setCommandResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [commandsBusy, setCommandsBusy] = useState(false);
  const [inviteOpened, setInviteOpened] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [guide, setGuide] = useState<GuideId | null>(null);
  const markModelReady = useCallback(() => setModelReady(true), []);

  const scan = async (): Promise<void> => {
    setScanning(true);
    setPrereqs(await api.prereqsScan());
    setScanning(false);
  };

  useEffect(() => {
    void scan();
    void api.tunnelStatus().then(setTunnel);
    void refreshAudioDevices();
  }, []);

  useEffect(() => {
    localStorage.setItem(WIZARD_STEP_KEY, String(stepIdx));
  }, [stepIdx]);

  const installCable = async (): Promise<void> => {
    setInstallingCable(true);
    setCableInstallResult(null);
    try {
      const result = await api.vbcableInstall();
      setCableInstallResult(result);
      await scan();
    } finally {
      setInstallingCable(false);
    }
  };

  // Debounced Discord validation.
  useEffect(() => {
    if (!discordToken || !discordClientId) {
      setDiscordResult(null);
      return;
    }
    setDiscordBusy(true);
    const t = setTimeout(() => {
      void api.validateDiscord(discordToken, discordClientId).then((r) => {
        setDiscordResult(r);
        setDiscordBusy(false);
        if (r.ok) void api.credsSave({ discordToken, discordClientId });
      });
    }, 600);
    return () => clearTimeout(t);
  }, [discordToken, discordClientId]);

  // Debounced Spotify validation.
  useEffect(() => {
    if (!spotifyClientId || !spotifyClientSecret) {
      setSpotifyResult(null);
      return;
    }
    setSpotifyBusy(true);
    const t = setTimeout(() => {
      void api.validateSpotify(spotifyClientId, spotifyClientSecret).then((r) => {
        setSpotifyResult(r);
        setSpotifyBusy(false);
        if (r.ok) void api.credsSave({ spotifyClientId, spotifyClientSecret });
      });
    }, 600);
    return () => clearTimeout(t);
  }, [spotifyClientId, spotifyClientSecret]);

  const canNext = useMemo<boolean>(() => {
    switch (step) {
      case 'vbcable':
        return prereqs.vbcable.status === 'ok' && prereqs.ffmpeg.status === 'ok';
      case 'routing':
        return isAudioRoutingReady(audioReport);
      case 'discord':
        return discordResult?.ok === true;
      case 'spotify':
        return Boolean(tunnel.callbackUrl) && spotifyResult?.ok === true;
      case 'commands':
        return commandResult?.ok === true;
      case 'invite':
        return inviteOpened;
      case 'model':
        return modelReady;
      default:
        return true;
    }
  }, [step, prereqs, audioReport, discordResult, spotifyResult, commandResult, inviteOpened, modelReady]);

  const next = (): void => {
    if (!canNext) return;
    if (step === 'welcome' && prereqs.ffmpeg.status === 'ok' && prereqs.vbcable.status === 'ok') {
      setStepIdx(ORDER.indexOf('routing'));
      return;
    }
    setStepIdx((i) => Math.min(ORDER.length - 1, i + 1));
  };
  const back = (): void => setStepIdx((i) => Math.max(0, i - 1));
  const startTunnel = async (): Promise<void> => {
    setTunnelBusy(true);
    try {
      setTunnel(await api.tunnelStart());
    } catch (err) {
      setTunnel({ running: false, error: err instanceof Error ? err.message : 'Could not create the public Spotify redirect.' });
    } finally {
      setTunnelBusy(false);
    }
  };
  const copyText = async (value: string | undefined): Promise<void> => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
  };
  const refreshAudioDevices = async (): Promise<void> => {
    setAudioReport(await api.audioDevicesList());
  };
  const saveAudio = async (patch: Partial<AudioDeviceSettings>): Promise<void> => {
    const previous = audioReport;
    setAudioSaving(true);
    setAudioReport((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
    try {
      const settings = await api.audioDevicesSave(patch);
      setAudioReport((prev) => (prev ? { ...prev, settings } : prev));
    } catch {
      setAudioReport(previous);
    } finally {
      setAudioSaving(false);
    }
  };

  useEffect(() => {
    if (step !== 'spotify') return;
    let active = true;
    setTunnelBusy(true);
    void api.tunnelStart()
      .then((status) => {
        if (active) setTunnel(status);
      })
      .catch((err: unknown) => {
        if (active) setTunnel({ running: false, error: err instanceof Error ? err.message : 'Could not create the public Spotify redirect.' });
      })
      .finally(() => {
        if (active) setTunnelBusy(false);
      });
    return () => {
      active = false;
    };
  }, [step]);

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-3 p-4 sm:gap-5 sm:p-6">
      <div className="flex items-center gap-1.5">
        {ORDER.map((id, i) => (
          <div
            key={id}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${i <= stepIdx ? 'bg-accent' : 'bg-white/10'}`}
          />
        ))}
      </div>
      <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
        {TITLES[step]} <span className="text-base font-normal text-muted">· step {stepIdx + 1} of {ORDER.length}</span>
      </h1>

      <Card className="min-h-0 flex-1 overflow-auto">
        {step === 'welcome' && (
          <div className="space-y-3 text-sm leading-relaxed">
            <p>greenroom streams your own Spotify audio into a Discord voice channel from your PC. This setup connects the two end to end.</p>
            <p className="text-muted">You'll need: a Discord account, Spotify Premium, and about 10 minutes. We'll set up the audio cable and walk through two developer portals.</p>
            <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
              <Pill tone={prereqs.ffmpeg.status === 'ok' ? 'ok' : 'idle'} label="FFmpeg" detail={prereqs.ffmpeg.detail} />
              <Pill tone={prereqs.vbcable.status === 'ok' ? 'ok' : 'idle'} label="VB-Cable" detail={prereqs.vbcable.detail} />
            </div>
          </div>
        )}

        {step === 'vbcable' && (
          <div className="space-y-4 text-sm">
            <p>greenroom captures Spotify through VB-Audio Virtual Cable. {prereqs.vbcable.status === 'ok' ? 'It is installed.' : 'It is not installed yet.'}</p>
            <Pill tone={prereqs.vbcable.status === 'ok' ? 'ok' : 'bad'} label="VB-Cable" detail={prereqs.vbcable.detail} />
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setGuide('vbcable')}>
                <Icon name="play" size={16} />
                Show guide
              </Button>
              {prereqs.vbcable.status !== 'ok' && (
                <Button disabled={installingCable} onClick={() => void installCable()}>
                  {installingCable ? 'Installing…' : 'Install VB-Cable'}
                </Button>
              )}
              <Button variant="ghost" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Re-check'}</Button>
            </div>
            {cableInstallResult && (
              <p className={`text-xs ${cableInstallResult.ok ? 'text-accent' : 'text-danger'}`}>{cableInstallResult.message}</p>
            )}
            <p className="text-muted text-xs">greenroom downloads and extracts the official driver for you. Approve the Windows admin prompt, click Install, then restart Windows. When you stream, greenroom will switch Spotify to this cable and restore it when you stop.</p>
          </div>
        )}

        {step === 'routing' && (
          <div className="space-y-4 text-sm">
            <p>Choose where you want Spotify to play when Greenroom is not streaming. Greenroom handles the virtual cable automatically.</p>
            <AudioRoutingPanel
              report={audioReport}
              saving={audioSaving}
              onChange={(patch) => void saveAudio(patch)}
              onRefresh={() => void refreshAudioDevices()}
              context="onboarding"
            />
          </div>
        )}

        {step === 'discord' && (
          <div className="space-y-3 text-sm">
            <p>Create a bot at the Discord Developer Portal, enable Message Content Intent, and paste the token and Application ID.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setGuide('discord')}>
                <Icon name="play" size={16} />
                Show guide
              </Button>
              <Button variant="ghost" onClick={() => window.open(GUIDES.discord.primaryUrl, '_blank')}>
                <Icon name="link" size={16} />
                Open portal
              </Button>
            </div>
            <Field label="Bot token" mono type="password" placeholder="Paste the bot token" value={discordToken} onChange={(e) => setDiscordToken(e.target.value)} />
            <Field label="Application ID" mono placeholder="17-20 digit Application ID" value={discordClientId} onChange={(e) => setDiscordClientId(e.target.value)} />
            {discordBusy && <p className="text-muted text-xs">Checking…</p>}
            {discordResult?.ok && (
              <div className="flex items-center gap-2 text-accent">
                {discordResult.avatarUrl && <img src={discordResult.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
                Connected as {discordResult.botName}
              </div>
            )}
            {discordResult && !discordResult.ok && <p className="text-danger text-xs">{discordResult.error}</p>}
          </div>
        )}

        {step === 'spotify' && (
          <div className="space-y-3 text-sm">
            <p>greenroom creates the public Spotify callback before you enter credentials. Add this exact Redirect URI in the Spotify Developer Dashboard:</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setGuide('spotify')}>
                <Icon name="play" size={16} />
                Show guide
              </Button>
              <Button variant="ghost" onClick={() => window.open(GUIDES.spotify.primaryUrl, '_blank')}>
                <Icon name="link" size={16} />
                Open dashboard
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <Code className={`block min-w-0 truncate py-2 ${tunnel.callbackUrl ? '' : 'text-muted'}`}>
                {tunnel.callbackUrl ?? (tunnelBusy ? 'Preparing your public Spotify redirect…' : 'Could not create the redirect yet. Retry below.')}
              </Code>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={tunnelBusy} onClick={() => void startTunnel()}>
                  {tunnelBusy ? 'Preparing…' : tunnel.callbackUrl ? 'Refresh redirect' : 'Retry'}
                </Button>
                <Button variant="ghost" disabled={!tunnel.callbackUrl} onClick={() => void copyText(tunnel.callbackUrl)}>
                  <Icon name="clipboard" size={16} />
                  Copy
                </Button>
              </div>
            </div>
            {tunnel.error && <p className="text-warn text-xs">{tunnel.error}</p>}
            <Field label="Client ID" mono placeholder="Paste the Spotify Client ID" value={spotifyClientId} onChange={(e) => setSpotifyClientId(e.target.value)} />
            <Field label="Client Secret" mono type="password" placeholder="Paste the Spotify Client Secret" value={spotifyClientSecret} onChange={(e) => setSpotifyClientSecret(e.target.value)} />
            {spotifyBusy && <p className="text-muted text-xs">Checking…</p>}
            {spotifyResult?.ok && <p className="text-accent">Spotify credentials verified.</p>}
            {spotifyResult && !spotifyResult.ok && <p className="text-danger text-xs">{spotifyResult.error}</p>}
          </div>
        )}

        {step === 'commands' && (
          <div className="space-y-3 text-sm">
            <p>Register the slash commands ( /login, /play, /queue, /stop, /effect ) with Discord.</p>
            <Button
              disabled={commandsBusy}
              onClick={() => {
                setCommandsBusy(true);
                setCommandResult(null);
                void api.commandsRegister()
                  .then((r) =>
                    setCommandResult({
                      ok: r.ok,
                      message: r.ok ? 'Slash commands are ready.' : (r.error ?? 'Could not register slash commands. Try again.'),
                    }),
                  )
                  .catch(() => setCommandResult({ ok: false, message: 'Could not register slash commands. Try again.' }))
                  .finally(() => setCommandsBusy(false));
              }}
            >
              {commandsBusy ? 'Registering…' : commandResult && !commandResult.ok ? 'Retry registration' : 'Register commands'}
            </Button>
            {commandResult && (
              <p className={commandResult.ok ? 'text-accent' : 'text-danger'}>{commandResult.message}</p>
            )}
          </div>
        )}

        {step === 'invite' && (
          <div className="space-y-3 text-sm">
            <p>Invite the bot to your server with the right permissions.</p>
            <Button
              variant="ghost"
              onClick={() => {
                window.open(botInviteUrl(discordClientId), '_blank');
                setInviteOpened(true);
              }}
              disabled={!discordClientId}
            >
              Open invite link
            </Button>
            {inviteOpened && <p className="text-accent">Invite link opened.</p>}
          </div>
        )}

        {step === 'model' && <ModelStep onReady={markModelReady} />}

        {step === 'finish' && <FinishStep />}
      </Card>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={back} disabled={stepIdx === 0}>Back</Button>
        {step === 'finish' ? (
          <Button onClick={() => { localStorage.removeItem(WIZARD_STEP_KEY); void api.engineStart(); onDone(); }}>Go to dashboard</Button>
        ) : (
          <Button onClick={next} disabled={!canNext}>Next</Button>
        )}
      </div>

      {guide && <GuideModal guide={GUIDES[guide]} onClose={() => setGuide(null)} />}
    </div>
  );
}

function GuideModal({ guide, onClose }: { guide: Guide; onClose: () => void }): JSX.Element {
  const [videoFailed, setVideoFailed] = useState(false);
  const showVideo = Boolean(guide.videoSrc && !videoFailed);

  return (
    <Modal size="lg" onClose={onClose} labelledBy="guide-title">
      <div className="space-y-4 overflow-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="guide-title" className="text-base font-semibold tracking-tight">{guide.title}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{guide.summary}</p>
          </div>
          <button
            className="app-no-drag grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/10 hover:text-text"
            aria-label="Close guide"
            title="Close"
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="currentColor" strokeWidth="1.4" />
              <line x1="11.5" y1="2.5" x2="2.5" y2="11.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>

        {showVideo ? (
          <video
            className="aspect-[8/5] w-full rounded-lg border border-line bg-black"
            src={guide.videoSrc}
            poster={guide.posterSrc}
            controls
            muted
            playsInline
            onError={() => setVideoFailed(true)}
          />
        ) : (
          <div className="rounded-lg border border-line bg-sunken p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
              <Icon name="play" size={16} />
              Setup walkthrough
            </div>
            <div className="space-y-2">
              {guide.steps.map((item, index) => (
                <div key={item} className="flex gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[13px]">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-medium text-accent">{index + 1}</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={() => window.open(guide.primaryUrl, '_blank')}>
            <Icon name="link" size={16} />
            {guide.primaryLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ModelStep({ onReady }: { onReady: () => void }): JSX.Element {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const off = api.onModelProgress((p) => {
      setProgress(p.totalBytes ? (p.receivedBytes / p.totalBytes) * 100 : 0);
    });
    setError(null);
    void api.modelEnsure()
      .then(() => {
        setProgress(100);
        setError(null);
        onReady();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Model download failed.');
      });
    return off;
  }, [attempt, onReady]);

  return (
    <div className="space-y-4 text-sm">
      <p>greenroom uses a local model for conversational command routing. Wait for this download to finish before continuing.</p>
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>Local AI model</span>
          <span>{progress === null ? 'starting…' : progress >= 100 ? 'ready' : `${Math.round(progress)}%`}</span>
        </div>
        <ProgressBar value={progress ?? 0} />
      </div>
      {error && (
        <div className="space-y-2">
          <p className="text-danger text-xs">{error}</p>
          <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      )}
    </div>
  );
}

function FinishStep(): JSX.Element {
  return (
    <div className="space-y-4 text-sm">
      <p>Last step: verify playback. Start the bot, run <Code>/login</Code> in Discord, join a voice channel, and run <Code>/play</Code>.</p>
      <p className="text-muted text-xs">Success = Discord hears Spotify and the dashboard shows active playback. If it is silent, open support and greenroom will include the audio-routing error.</p>
    </div>
  );
}
