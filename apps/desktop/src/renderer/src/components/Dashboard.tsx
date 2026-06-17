import { useEffect, useRef, useState } from 'react';
import type { EngineSnapshot, EngineState, LogLine } from '@greenroom/shared';
import { EMPTY_PREREQS } from '@greenroom/shared';
import { api } from '../lib/api';
import { Button, Card, Code, Modal, SectionHeader } from './ui';
import { Icon, type IconName } from './Icon';
import { SettingsModal } from './SettingsModal';
import { MusicVisualizer } from './MusicVisualizer';
import { NowPlaying } from './NowPlaying';
import { useLoopbackLevel } from '../lib/useLoopbackLevel';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/** Plump glyph per status tone, used for the quiet typographic status treatment. */
const TONE_ICON: Record<Exclude<Tone, 'idle'>, IconName> = {
  ok: 'check',
  warn: 'warning',
  bad: 'stopsign',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-accent',
  warn: 'text-warn',
  bad: 'text-danger',
  idle: 'text-muted',
};

/** Single source for the command card - mirrors engine/src/register-commands.ts. */
const COMMANDS: { emoji: IconName; command: string; detail: string }[] = [
  { emoji: 'key', command: '/login', detail: 'Link your Spotify account (once).' },
  { emoji: 'play', command: '/play', detail: 'Stream your Spotify session into voice.' },
  { emoji: 'notes', command: '/queue', detail: 'Queue a song, playlist, or Spotify link.' },
  { emoji: 'broom', command: '/clearqueue', detail: 'Clear the pending Spotify queue.' },
  { emoji: 'stop', command: '/stop', detail: 'Stop streaming and pause playback.' },
  { emoji: 'knobs', command: '/effect', detail: 'Bass boost, speed up, or slow down.' },
];

const STATE_LABEL: Record<EngineState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  idle: { label: 'Stopped', tone: 'idle' },
  preflight: { label: 'Preflight', tone: 'warn' },
  starting: { label: 'Starting…', tone: 'warn' },
  running: { label: 'Running', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  stopping: { label: 'Stopping…', tone: 'warn' },
  crashed: { label: 'Crashed', tone: 'bad' },
};

interface FriendlyLogItem {
  title: string;
  detail?: string;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
}

interface ActivityItem extends FriendlyLogItem {
  key: string;
  ts: number;
}

function isAudioEngineLine(text: string): boolean {
  return /^\[AudioEngine(?:\s+FFmpeg)?\]/i.test(text) || /^\[Error\]\s+FFmpeg/i.test(text);
}

function isAudioEngineProblem(text: string): boolean {
  return isAudioEngineLine(text) && /failed|error|not found|cannot|invalid|unavailable/i.test(text);
}

function isFfmpegContinuationLine(text: string): boolean {
  return (
    /^\s*(built with|configuration:|libav\w+|libsw\w+|libpostproc)\b/i.test(text) ||
    /^\s*--enable-/i.test(text) ||
    /^\s*(Input|Output|Duration|Stream|Metadata|encoder)\b/i.test(text) ||
    /^\s*\S+\s*->\s*#\d+/i.test(text)
  );
}

function isRoutineLog(text: string): boolean {
  return (
    /^=+$/.test(text.trim()) ||
    /engine bootstrapping/i.test(text) ||
    /auth server listening/i.test(text) ||
    /login links use/i.test(text) ||
    /redirect URI is/i.test(text) ||
    /logged in as/i.test(text) ||
    /using the rule-based parser/i.test(text) ||
    /\[Bootstrap\] Fix: open the Discord Developer Portal/i.test(text) ||
    /loaded \d+ linked Spotify profile/i.test(text) ||
    /loaded \d+ user profile/i.test(text) ||
    /\[Bot\] Ready\. Loaded \d+ user profile mapping/i.test(text) ||
    /local llm ready/i.test(text) ||
    /\[SemanticParser\]/i.test(text) ||
    /\[Spotify\] Searching /i.test(text) ||
    /\[VoiceConnection\] Ready/i.test(text) ||
    /\[DiscordVoicePlayer\] Streaming loopback audio/i.test(text) ||
    /\[Bot\] Optimizing bitrate/i.test(text) ||
    /\[Bot\] Could not optimize bitrate/i.test(text)
  );
}

function isUserFacingLog(line: LogLine): boolean {
  const text = line.text;
  if (isRoutineLog(text)) return false;
  if (isFfmpegContinuationLine(text)) return false;
  if (isAudioEngineLine(text) && !isAudioEngineProblem(text)) return false;
  return true;
}

function friendlyLog(line: LogLine): FriendlyLogItem {
  const text = line.text;
  if (/discord login failed.*used disallowed intents/i.test(text)) {
    return {
      title: 'Discord setup needs attention',
      detail: 'Enable Message Content Intent in the Discord Developer Portal, then start the bot again.',
      tone: 'bad',
    };
  }
  if (/discord login failed/i.test(text)) {
    return { title: 'Discord login failed', detail: text.replace(/^.*discord login failed:\s*/i, ''), tone: 'bad' };
  }
  if (/port .* already in use|port .* unavailable/i.test(text)) return { title: 'Spotify login port is busy', detail: 'Another app is using the login callback port.', tone: 'bad' };
  if (/spotify linked|authorization successful/i.test(text)) return { title: 'Spotify account linked', detail: 'A user completed Spotify login.', tone: 'ok' };
  if (/\[AudioRouting\] Spotify audio is routed/i.test(text)) return { title: 'Spotify audio routed', detail: 'Spotify is now sending music to Discord.', tone: 'ok' };
  if (/\[AudioRouting\] Spotify audio was restored/i.test(text)) return { title: 'Spotify audio restored', detail: 'Spotify is back on your normal output.', tone: 'idle' };
  if (/\[AudioRouting\] Could not route Spotify automatically/i.test(text)) {
    return { title: 'Spotify audio routing needs attention', detail: 'Open Spotify and try again. If it stays silent, use the support report.', tone: 'warn' };
  }
  if (/\[AudioRouting\] Could not restore Spotify audio/i.test(text)) {
    return { title: 'Spotify audio did not restore', detail: 'Set Spotify back to your speakers in Windows Volume Mixer.', tone: 'warn' };
  }
  if (isAudioEngineProblem(text)) return { title: 'Audio capture issue', detail: 'greenroom could not start the local audio stream.', tone: 'bad' };
  if (/auto-resume failed/i.test(text)) return { title: 'Spotify playback did not auto-start', detail: 'Open Spotify desktop and start playback, then try again.', tone: 'warn' };
  if (/failed|error|critical/i.test(text)) return { title: 'Something needs attention', detail: text, tone: 'bad' };
  if (/warn|warning/i.test(text) || line.level === 'warn') return { title: 'Heads up', detail: text, tone: 'warn' };
  return { title: text.replace(/^\[[^\]]+\]\s*/, ''), tone: line.level === 'error' ? 'bad' : 'idle' };
}

export function Dashboard(): JSX.Element {
  const [snapshot, setSnapshot] = useState<EngineSnapshot>({
    state: 'idle',
    prereqs: EMPTY_PREREQS,
    spotifyLinked: false,
    captureActive: false,
  });
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [vbAlertDismissed, setVbAlertDismissed] = useState(false);
  const snapshotRef = useRef(snapshot);
  const levelRef = useLoopbackLevel(snapshot.captureActive);

  const addActivity = (item: ActivityItem): void => {
    setActivity((prev) => [...prev.filter((entry) => entry.key !== item.key), item].slice(-50));
  };

  const applySnapshot = (next: EngineSnapshot): void => {
    const previous = snapshotRef.current;
    snapshotRef.current = next;
    setSnapshot(next);
    if (next.state === 'starting' && previous.state !== 'starting') {
      addActivity({ key: 'bot-starting', ts: Date.now(), title: 'Starting the bot…', detail: 'Connecting to Discord and Spotify.', tone: 'warn' });
    }
    if (next.state === 'running' && previous.state !== 'running') {
      addActivity({ key: 'bot-online', ts: Date.now(), title: 'Bot is online', detail: 'Ready for commands in Discord.', tone: 'ok' });
    }
    if (next.state === 'idle' && previous.state !== 'idle') {
      addActivity({ key: 'bot-offline', ts: Date.now(), title: 'Bot stopped', detail: 'Start it again when you want to use Discord commands.', tone: 'idle' });
    }
    if (next.spotifyLinked && !previous.spotifyLinked) {
      addActivity({ key: 'spotify-linked', ts: Date.now(), title: 'Spotify account linked', detail: 'Spotify requests are ready.', tone: 'ok' });
    }
    if (next.captureActive && !previous.captureActive) {
      addActivity({ key: 'music-streaming', ts: Date.now(), title: 'Music is streaming', detail: 'Spotify audio is playing in Discord.', tone: 'ok' });
    }
    if (next.lastError && next.lastError !== previous.lastError) {
      addActivity({ key: `error-${next.lastError}`, ts: Date.now(), title: 'Something needs attention', detail: next.lastError, tone: 'bad' });
    }
  };

  const failMessage = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

  const startBot = async (): Promise<void> => {
    const previous = snapshotRef.current;
    const withoutError = { ...previous };
    delete withoutError.lastError;
    applySnapshot({ ...withoutError, state: 'starting' });
    try {
      applySnapshot(await api.engineStart());
    } catch (err) {
      applySnapshot({ ...previous, lastError: failMessage(err, 'Could not start the bot.') });
    }
  };

  const stopBot = async (): Promise<void> => {
    const previous = snapshotRef.current;
    const withoutError = { ...previous };
    delete withoutError.lastError;
    applySnapshot({ ...withoutError, state: 'stopping' });
    try {
      applySnapshot(await api.engineStop());
    } catch (err) {
      applySnapshot({ ...previous, lastError: failMessage(err, 'Could not stop the bot.') });
    }
  };

  useEffect(() => {
    void api.engineGetSnapshot().then(applySnapshot);
    void api.prereqsScan();
    void api.discordInviteUrl().then(setInviteUrl);
    const offState = api.onEngineState(applySnapshot);
    const offLog = api.onEngineLog((lines) => {
      for (const line of lines) {
        if (!isUserFacingLog(line)) continue;
        const item = friendlyLog(line);
        addActivity({ ...item, key: `${item.title}\n${item.detail ?? ''}`, ts: line.ts });
      }
    });
    const offPrereqs = api.onPrereqs((prereqs) => setSnapshot((prev) => ({ ...prev, prereqs })));
    return () => {
      offState();
      offLog();
      offPrereqs();
    };
  }, []);

  const running = snapshot.state === 'running' || snapshot.state === 'degraded' || snapshot.state === 'starting';
  const stateInfo = STATE_LABEL[snapshot.state];
  const vbCableProblem = snapshot.prereqs.vbcable.status !== 'ok' && snapshot.prereqs.vbcable.status !== 'unknown';
  const needsSetup = !snapshot.spotifyLinked;
  const transitioning = snapshot.state === 'starting' || snapshot.state === 'stopping';
  const homeTone: Tone = snapshot.lastError ? 'bad' : transitioning ? 'warn' : !running ? 'idle' : needsSetup ? 'warn' : 'ok';
  const homeIcon: IconName = snapshot.lastError
    ? 'stopsign'
    : transitioning
      ? 'radio'
      : homeTone === 'ok'
        ? snapshot.captureActive ? 'note' : 'check'
        : homeTone === 'warn'
          ? 'warning'
          : 'radio';
  const homeTitle = snapshot.lastError
    ? 'Something needs attention'
    : snapshot.state === 'starting'
      ? 'Starting the bot…'
      : snapshot.state === 'stopping'
        ? 'Stopping…'
        : !running
          ? 'Bot is off'
          : needsSetup
            ? 'Spotify needs linking'
            : snapshot.captureActive
              ? 'Music is streaming'
              : 'Ready in Discord';
  const nextStep = snapshot.lastError
    ? snapshot.lastError
    : snapshot.state === 'starting'
      ? 'Connecting to Discord and Spotify. This usually takes a few seconds.'
      : snapshot.state === 'stopping'
        ? 'Shutting down the engine.'
        : !running
          ? 'Start the bot before using Discord commands.'
          : needsSetup
            ? 'In Discord, run /login and link your Spotify account.'
            : snapshot.captureActive
              ? 'Use /queue to add more music or /clearqueue to empty a long playlist.'
              : 'Use /play with a song name, playlist, or Spotify link.';
  return (
    <div className="mx-auto h-full max-w-5xl overflow-auto p-4 sm:p-6">
      <div className="flex min-h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {stateInfo.tone !== 'idle' && <Icon name={TONE_ICON[stateInfo.tone]} size={16} className={TONE_TEXT[stateInfo.tone]} />}
          <span className={`text-xs font-semibold uppercase tracking-[0.14em] ${TONE_TEXT[stateInfo.tone]}`}>
            {stateInfo.label}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={!inviteUrl} onClick={() => inviteUrl && window.open(inviteUrl, '_blank')}>
            <Icon name="wave" size={16} />
            Invite bot
          </Button>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={16} />
            Settings
          </Button>
          {running ? (
            <Button variant="danger" disabled={transitioning} onClick={() => void stopBot()}>
              <Icon name="stop" size={15} />
              Stop
            </Button>
          ) : (
            <Button disabled={transitioning} onClick={() => void startBot()}>
              <Icon name="rocket" size={16} />
              Start bot
            </Button>
          )}
        </div>
      </header>

      {snapshot.captureActive && (
        <NowPlaying
          nowPlaying={snapshot.nowPlaying}
          guildName={snapshot.guildName}
          channelName={snapshot.channelName}
          levelRef={levelRef}
        />
      )}

      <div className="grid gap-4 min-[980px]:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <section className="grid min-w-0 min-h-0 content-start gap-4">
          <Card className="min-w-0 space-y-5 shadow-highlight">
            <div className="flex items-start gap-3">
              <Icon name={homeIcon} size={30} className={`mt-0.5 shrink-0 ${TONE_TEXT[homeTone]}`} />
              <div className="min-w-0">
                <h1 className="text-base font-semibold tracking-tight">{homeTitle}</h1>
                <p className="mt-1 break-words text-[13px] leading-relaxed text-muted">{nextStep}</p>
              </div>
            </div>

            {/* The headline already conveys bot state, so the chips carry only the two
                facts it can't: whether Spotify is linked and whether audio is flowing. */}
            <div className="flex flex-wrap gap-2">
              <StatusChip
                tone={!running ? 'idle' : snapshot.spotifyLinked ? 'ok' : 'warn'}
                text={!running ? 'Spotify checked on start' : snapshot.spotifyLinked ? 'Spotify linked' : 'Spotify needs /login'}
              />
              <StatusChip
                tone={snapshot.captureActive ? 'ok' : 'idle'}
                text={snapshot.captureActive ? 'Audio streaming' : running ? 'Audio starts with /play' : 'Audio off'}
              />
            </div>
          </Card>

          <Card className="min-w-0 space-y-3">
            <SectionHeader label="Use in Discord" icon={<Icon name="chat" size={16} />} />
            <div className="space-y-1 text-sm">
              {COMMANDS.map((c) => (
                <CommandRow key={c.command} emoji={c.emoji} command={c.command} detail={c.detail} />
              ))}
            </div>
            <p className="border-t border-line/60 pt-2.5 text-xs leading-relaxed text-muted">
              Or just @mention the bot in chat, like <span className="text-text/80">"@greenroom play some lofi"</span>.
            </p>
          </Card>
        </section>

        <Card className="flex min-w-0 min-h-[360px] flex-col">
          <SectionHeader
            label="Recent activity"
            detail="What Greenroom has done this session."
            icon={<Icon name="sparkles" size={16} />}
            className="mb-3"
          />
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-sunken text-sm">
            {/* Living equalizer: a persistent footer whenever the bot is on (reactive while streaming),
                plus the idle empty state. Sits behind the scrolling list. */}
            {(running || activity.length === 0) && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 opacity-60">
                <MusicVisualizer active={running} levelRef={levelRef} />
              </div>
            )}
            <div className="relative h-full overflow-auto p-3">
              {activity.length === 0 ? (
                <div className="grid h-full place-items-center text-center text-muted">
                  <div>
                    <div className="text-sm font-medium text-text/80">{running ? 'Ready for your first request' : 'Nothing happening yet'}</div>
                    <div className="mt-1 text-xs">{running ? 'Use /play in Discord to start music.' : 'Start the bot when you want to use it.'}</div>
                  </div>
                </div>
              ) : (
                activity.map((item) => {
                  return (
                  <div key={item.key} className="mb-2 flex gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2 last:mb-0">
                    <Icon name={item.tone === 'idle' ? 'note' : TONE_ICON[item.tone]} size={15} className={`mt-0.5 shrink-0 ${TONE_TEXT[item.tone]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="min-w-0 break-words font-medium">{item.title}</span>
                        <span className="shrink-0 text-xs text-muted">{new Date(item.ts).toLocaleTimeString()}</span>
                      </div>
                      {item.detail && <div className="mt-0.5 break-words text-xs text-muted">{item.detail}</div>}
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </Card>
      </div>

      {settingsOpen && (
        <SettingsModal
          prereqs={snapshot.prereqs}
          onClose={() => setSettingsOpen(false)}
          onPrereqs={(prereqs) => setSnapshot((prev) => ({ ...prev, prereqs }))}
        />
      )}

      {vbCableProblem && !vbAlertDismissed && !settingsOpen && (
        <Modal size="sm" onClose={() => setVbAlertDismissed(true)} labelledBy="vb-alert-title">
          <div className="space-y-3 p-5">
            <h2 id="vb-alert-title" className="text-base font-semibold tracking-tight">
              VB-Cable needs attention
            </h2>
            <p className="text-[13px] leading-relaxed text-muted">
              {snapshot.prereqs.vbcable.detail ?? 'greenroom could not verify VB-Audio Virtual Cable.'}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setVbAlertDismissed(true)}>Dismiss</Button>
              <Button
                onClick={() => {
                  setVbAlertDismissed(true);
                  setSettingsOpen(true);
                }}
              >
                Open settings
              </Button>
            </div>
          </div>
        </Modal>
      )}
      </div>
    </div>
  );
}

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-accent',
  warn: 'bg-warn',
  bad: 'bg-danger',
  idle: 'bg-muted',
};

/** Compact status chip: a tone dot plus a self-contained phrase. Lighter than a label/value row. */
function StatusChip({ tone, text }: { tone: Tone; text: string }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line/70 bg-white/[0.03] px-2.5 py-1">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className={`truncate text-xs font-medium ${TONE_TEXT[tone]}`}>{text}</span>
    </span>
  );
}

function CommandRow({ emoji, command, detail }: { emoji: IconName; command: string; detail: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.03]">
      <Icon name={emoji} size={18} className="mt-0.5 shrink-0 text-accent" />
      <Code className="shrink-0">{command}</Code>
      <span className="min-w-0 text-xs leading-snug text-muted">{detail}</span>
    </div>
  );
}
