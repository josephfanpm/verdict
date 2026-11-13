import { Archive, ChevronRight, FlaskConical, Plus, WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { FlagSummary } from '../api';
import { ProgressRing } from '../components/ProgressRing';
import { Button } from '../components/ui/button';
import { Segmented } from '../components/ui/segmented';
import { Tooltip } from '../components/ui/tooltip';
import { num, pct } from '../format';
import { flagHref } from '../router';
import { DECIDED, VERDICT, VerdictBadge, VerdictIcon } from '../verdict';

type Filter = 'all' | 'decide' | 'running' | 'off';

const MATCHES: Record<Filter, (f: FlagSummary) => boolean> = {
  all: () => true,
  decide: (f) => DECIDED.includes(f.summary.verdict),
  running: (f) => f.flag.status === 'running' && !DECIDED.includes(f.summary.verdict),
  off: (f) => f.flag.status !== 'running',
};

const STATUS_LABEL = { draft: 'Draft', running: 'Running', stopped: 'Stopped', rolled_out: 'Rolled out', archived: 'Archived' } as const;

/** Verdicts that need attention sort first. */
const ORDER = ['INVESTIGATE', 'DONT_SHIP', 'SHIP', 'NO_DIFFERENCE', 'KEEP_RUNNING', 'NOT_STARTED'];

export function ExperimentsPage({ flags, error, onCreate }: { flags: FlagSummary[] | null; error: string | null; onCreate: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(
    () => (flags ?? []).filter(MATCHES[filter]).sort((a, b) => ORDER.indexOf(a.summary.verdict) - ORDER.indexOf(b.summary.verdict)),
    [flags, filter]
  );

  if (error && !flags) {
    return (
      <EmptyState icon={<WifiOff className="size-6" />} title="Can't reach the Verdict API" body={error}>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </EmptyState>
    );
  }

  const total = flags?.reduce((s, f) => s + f.summary.totalExposures, 0) ?? 0;
  const counts = Object.fromEntries((Object.keys(MATCHES) as Filter[]).map((k) => [k, flags?.filter(MATCHES[k]).length ?? 0])) as Record<Filter, number>;

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">Experiments</h1>
          <p className="mt-1 text-fg-muted">
            {flags ? (
              <>
                {flags.length} experiment{flags.length === 1 ? '' : 's'} · {num(total)} users
              </>
            ) : (
              <span className="inline-block h-4 w-40 animate-pulse rounded bg-bg-subtle align-middle" />
            )}
          </p>
        </div>
        <Button variant="primary" onClick={onCreate} className="sm:hidden">
          <Plus /> New
        </Button>
      </div>

      {flags && flags.length > 0 && (
        <Segmented
          label="Filter experiments"
          className="mb-5"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'decide', label: 'Ready to decide', count: counts.decide },
            { value: 'running', label: 'Running', count: counts.running },
            { value: 'off', label: 'Not running', count: counts.off },
          ]}
        />
      )}

      {!flags ? (
        <ListSkeleton />
      ) : flags.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-6" />}
          title="No experiments yet"
          body={
            <>
              Create one, or run <code className="rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[13px]">npm run simulate</code> for demo data.
            </>
          }
        >
          <Button variant="primary" onClick={onCreate}>
            <Plus /> New experiment
          </Button>
        </EmptyState>
      ) : visible.length === 0 ? (
        <p className="py-16 text-center text-fg-muted">Nothing here.</p>
      ) : (
        <ul className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((item, i) => (
              <motion.li
                key={item.flag.key}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 8) * 0.03 } }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
                className="border-b border-border last:border-b-0"
              >
                <Row item={item} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

function Row({ item: { flag, summary } }: { item: FlagSummary }) {
  const showProgress = flag.status === 'running' && summary.totalExposures > 0;
  return (
    <a
      href={flagHref(flag.key)}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-4 transition-colors hover:bg-bg-subtle sm:grid-cols-[auto_1fr_96px_56px_148px_auto] sm:px-6"
    >
      <VerdictIcon kind={summary.verdict} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold tracking-tight">{flag.key}</span>
          {flag.status !== 'running' && (
            <span className="shrink-0 rounded-full bg-neutral-bg px-2 py-0.5 text-[11px] font-medium text-fg-muted">{STATUS_LABEL[flag.status]}</span>
          )}
          {summary.cleanup && (
            <Tooltip content={summary.cleanup}>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-medium text-warn">
                <Archive className="size-3" /> Clean up
              </span>
            </Tooltip>
          )}
        </div>
        <p className="truncate text-sm text-fg-muted">{flag.description || 'No description'}</p>
        <div className="mt-1.5 flex items-center gap-2 sm:hidden">
          <span className={`text-[13px] font-medium ${VERDICT[summary.verdict].text}`}>{VERDICT[summary.verdict].label}</span>
          <span className="text-[13px] text-fg-faint">· {num(summary.totalExposures)} users</span>
        </div>
      </div>

      <div className="hidden text-right sm:block">
        <div className="tabular text-sm font-medium">{num(summary.totalExposures)}</div>
        <div className="text-xs text-fg-faint">users</div>
      </div>

      <div className="hidden justify-center sm:flex">
        {showProgress ? (
          <Tooltip content={`${pct(summary.progress, 0)} of planned sample`}>
            <span>
              <ProgressRing value={summary.progress} />
            </span>
          </Tooltip>
        ) : (
          <span className="text-fg-faint">–</span>
        )}
      </div>

      <div className="hidden sm:block">
        <VerdictBadge kind={summary.verdict} />
      </div>

      <ChevronRight className="size-4 text-fg-faint transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-surface">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-6 py-5 last:border-b-0">
          <div className="size-10 animate-pulse rounded-full bg-bg-subtle" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-bg-subtle" />
            <div className="h-3 w-72 max-w-full animate-pulse rounded bg-bg-subtle" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, body, children }: { icon: React.ReactNode; title: string; body: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-border-strong px-6 py-20 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-full bg-bg-subtle text-fg-muted">{icon}</div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">{body}</p>
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
