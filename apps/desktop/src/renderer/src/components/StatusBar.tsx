import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useUpdater } from '../lib/useUpdater';

export function StatusBar(): JSX.Element {
  const updaterStatus = useUpdater();
  const [checkingNow, setCheckingNow] = useState(false);
  const update = checkingNow && updaterStatus.phase === 'idle' ? { ...updaterStatus, phase: 'checking' as const } : updaterStatus;
  const version = update.currentVersion ? `v${update.currentVersion}` : '';

  useEffect(() => {
    if (updaterStatus.phase !== 'idle') setCheckingNow(false);
  }, [updaterStatus.phase]);

  const label = (() => {
    switch (update.phase) {
      case 'checking':
        return `Checking for updates${version ? ` · ${version}` : ''}`;
      case 'available':
        return `Update found${update.version ? ` · v${update.version}` : ''}`;
      case 'downloading':
        return `Downloading update${update.percent === undefined ? '' : ` · ${Math.round(update.percent)}%`}`;
      case 'downloaded':
        return `Restart to update${update.version ? ` · v${update.version}` : ''}`;
      case 'up-to-date':
        return `Up to date${version ? ` · ${version}` : ''}`;
      case 'error':
        return `Retry update check${version ? ` · ${version}` : ''}`;
      default:
        return `Check for updates${version ? ` · ${version}` : ''}`;
    }
  })();

  const disabled = !update.supported || update.phase === 'checking' || update.phase === 'available' || update.phase === 'downloading';
  const checkForUpdates = async (): Promise<void> => {
    setCheckingNow(true);
    try {
      await api.updaterCheck();
    } finally {
      setCheckingNow(false);
    }
  };
  const action = update.phase === 'downloaded' ? api.updaterInstall : checkForUpdates;

  return (
    <footer className="app-no-drag flex h-8 shrink-0 items-center justify-end border-t border-line bg-bg px-4">
      <button
        className={`h-full text-[11px] transition-colors focus-visible:outline-none focus-visible:text-text ${
          update.phase === 'downloaded'
            ? 'font-medium text-accent hover:text-accent-hover'
            : update.phase === 'error'
              ? 'text-warn hover:text-text'
              : 'text-muted hover:text-text disabled:text-muted/60'
        }`}
        disabled={disabled}
        title={update.error ?? label}
        onClick={() => void action()}
      >
        {update.supported ? label : version}
      </button>
    </footer>
  );
}
