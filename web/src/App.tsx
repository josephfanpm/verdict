import { Command, Moon, Plus, Settings, Sun } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { api, type FlagSummary } from './api';
import { CommandMenu } from './components/CommandMenu';
import { NewExperimentDialog } from './components/NewExperimentDialog';
import { TokenDialog } from './components/TokenDialog';
import { Button } from './components/ui/button';
import { Tooltip, TooltipProvider } from './components/ui/tooltip';
import { ExperimentPage } from './pages/ExperimentPage';
import { ExperimentsPage } from './pages/ExperimentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useRoute } from './router';
import { useTheme } from './theme';

export function App() {
  const route = useRoute();
  const { toggle } = useTheme();
  const [flags, setFlags] = useState<FlagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const reloadFlags = useCallback(async () => {
    try {
      setFlags(await api.listFlags());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reloadFlags();
  }, [reloadFlags, route]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <MotionConfig reducedMotion="user">
    <TooltipProvider delayDuration={300}>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-fg">
              <svg viewBox="0 0 32 32" className="size-4" aria-hidden>
                <path d="M9 16.5l4.5 4.5L23 11" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Verdict
          </a>

          <button
            onClick={() => setCommandOpen(true)}
            className="ml-auto flex h-9 items-center gap-2 rounded-full bg-bg-subtle px-3 text-[13px] text-fg-muted ring-1 ring-inset ring-border transition-colors hover:text-fg sm:w-64"
          >
            <span className="hidden sm:inline">Search experiments…</span>
            <span className="sm:hidden">Search</span>
            <kbd className="ml-auto hidden items-center gap-0.5 rounded-md bg-surface px-1.5 py-0.5 font-sans text-[11px] text-fg-faint ring-1 ring-border sm:flex">
              {isMac ? <Command className="size-3" /> : 'Ctrl '}K
            </kbd>
          </button>

          <Tooltip content="Settings">
            <Button asChild variant="ghost" size="icon" aria-label="Settings">
              <a href="#/settings">
                <Settings />
              </a>
            </Button>
          </Tooltip>

          <Tooltip content="Toggle theme">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
              <Sun className="hidden dark:block" />
              <Moon className="dark:hidden" />
            </Button>
          </Tooltip>

          <Button variant="primary" size="sm" onClick={() => setCreating(true)} className="hidden sm:inline-flex">
            <Plus /> New
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 sm:px-6 sm:pt-12">
        {route.page === 'flag' ? (
          <ExperimentPage key={route.key} flagKey={route.key} onChanged={reloadFlags} />
        ) : route.page === 'settings' ? (
          <SettingsPage />
        ) : (
          <ExperimentsPage flags={flags} error={error} onCreate={() => setCreating(true)} />
        )}
      </main>

      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        flags={flags ?? []}
        onCreate={() => setCreating(true)}
        onToggleTheme={toggle}
      />
      <NewExperimentDialog open={creating} onOpenChange={setCreating} />
      <TokenDialog />
      <Toaster position="top-center" closeButton theme="system" style={{ '--width': '420px' } as React.CSSProperties} toastOptions={{ className: 'font-sans' }} />
    </TooltipProvider>
    </MotionConfig>
  );
}
