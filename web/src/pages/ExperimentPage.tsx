import confetti from 'canvas-confetti';
import { Archive, Check, ChevronLeft, Copy, History, Play, Rocket, Square } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type AuditEntry, type ExperimentReport, type FlagConfig, type TimeseriesPoint } from '../api';
import { LiftForest } from '../components/LiftForest';
import { LiftOverTime } from '../components/LiftOverTime';
import { GuardrailsCard, HealthCard, SegmentsCard, StatTiles, VariantsTable, VerdictHero } from '../components/Results';
import { ConfigCard, LifecycleCard, Planner, Playground } from '../components/Setup';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { Segmented } from '../components/ui/segmented';
import { Tooltip } from '../components/ui/tooltip';
import { timeAgo } from '../format';

type Tab = 'results' | 'setup' | 'history';
const REFRESH_MS = 15_000;
const STALE_MS = 14 * 86_400_000;

export function ExperimentPage({ flagKey, onChanged }: { flagKey: string; onChanged: () => Promise<void> }) {
  const [flag, setFlag] = useState<FlagConfig | null>(null);
  const [report, setReport] = useState<ExperimentReport | null>(null);
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('results');
  /** Which phase's results are shown. Undefined follows the current phase. */
  const [phase, setPhase] = useState<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      // Results first: reading them is what locks the sample plan, and the flag should reflect that.
      const [r, t] = await Promise.all([api.results(flagKey, phase), api.timeseries(flagKey, phase)]);
      const [f, a] = await Promise.all([api.getFlag(flagKey), api.audit(flagKey)]);
      setFlag(f);
      setReport(r);
      setPoints(t);
      setAudit(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [flagKey, phase]);

  // Refresh quietly while the tab is visible, so the numbers roll as data arrives.
  useEffect(() => {
    void load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const viewingCurrent = phase === undefined || phase === flag?.phase;
  useCelebration(flagKey, viewingCurrent ? report : null);

  const saved = useCallback(async () => {
    setPhase(undefined);
    await Promise.all([load(), onChanged()]);
  }, [load, onChanged]);

  async function act(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast.success(done);
      await saved();
    } catch (e) {
      toast.error("Couldn't do that", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  if (error && !flag) {
    return (
      <div className="py-24 text-center">
        <p className="text-lg font-semibold">Couldn't load this experiment</p>
        <p className="mt-1 text-fg-muted">{error}</p>
        <Button asChild className="mt-6">
          <a href="#/">Back to experiments</a>
        </Button>
      </div>
    );
  }
  if (!flag || !report) return <DetailSkeleton />;

  const live = flag.status === 'running' || flag.status === 'rolled_out';
  const statusText = {
    draft: 'Draft',
    running: `Live · ${flag.rolloutPercent}%`,
    stopped: 'Stopped',
    rolled_out: `Rolled out · ${flag.rolledOutVariant}`,
    archived: 'Archived',
  }[flag.status];
  const stale = (flag.status === 'rolled_out' || flag.status === 'stopped') && flag.statusChangedAt !== null && Date.now() - flag.statusChangedAt > STALE_MS;
  const winner = report.verdict.winner;

  return (
    <div>
      <a href="#/" className="-ml-1 mb-6 inline-flex items-center gap-0.5 text-[15px] text-accent hover:underline">
        <ChevronLeft className="size-4" /> Experiments
      </a>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[36px]">{flag.key}</h1>
            <CopyKey value={flag.key} />
          </div>
          <p className="mt-1 max-w-2xl text-fg-muted">{flag.description || 'No description'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-[13px] text-fg-muted">
            <span className="relative flex size-2">
              {flag.status === 'running' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" />}
              <span className={`relative inline-flex size-2 rounded-full ${live ? 'bg-good' : 'bg-fg-faint'}`} />
            </span>
            {statusText}
            <span className="text-fg-faint">· v{flag.version}</span>
          </div>
          {/* The one next step the verdict points to. Everything else lives under Setup. */}
          {flag.status === 'draft' && (
            <Button variant="primary" size="sm" onClick={() => void act(() => api.start(flagKey), 'Started')}>
              <Play /> Start
            </Button>
          )}
          {flag.status === 'running' && viewingCurrent && report.verdict.kind === 'SHIP' && winner && (
            <Button variant="primary" size="sm" onClick={() => void act(() => api.rollout(flagKey, winner), `Rolled out ${winner}`)}>
              <Rocket /> Roll out {winner}
            </Button>
          )}
          {flag.status === 'running' && viewingCurrent && report.verdict.kind === 'DONT_SHIP' && (
            <Button variant="danger" size="sm" onClick={() => void act(() => api.stop(flagKey), 'Stopped')}>
              <Square /> Stop
            </Button>
          )}
        </div>
      </div>

      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-warn-bg px-5 py-3 text-[14px] text-warn">
          <span className="flex items-center gap-2 font-medium">
            <Archive className="size-4" /> Decided {timeAgo(flag.statusChangedAt!)}. Remove the flag from code, then archive it.
          </span>
          <Button size="sm" onClick={() => void act(() => api.archive(flagKey), 'Archived')}>
            Archive
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {flag.phases.length > 1 && (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Phase"
              value={String(phase ?? flag.phase)}
              onChange={(value) => setPhase(Number(value) === flag.phase ? undefined : Number(value))}
              options={flag.phases.map((p) => ({ value: String(p.number), label: `Phase ${p.number}` }))}
            />
            {!viewingCurrent && <span className="text-[13px] text-fg-muted">Closed {timeAgo(flag.phases.find((p) => p.number === phase)?.endedAt ?? Date.now())}</span>}
          </div>
        )}
        <VerdictHero report={report} />
        <StatTiles report={report} points={points} />
      </div>

      <div className="sticky top-14 z-20 -mx-4 mb-4 mt-10 bg-bg/80 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6">
        <Segmented
          label="Experiment sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'results', label: 'Results' },
            { value: 'setup', label: 'Setup' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        {tab === 'results' && (
          <div className="grid gap-4 lg:grid-cols-5 [&>*]:min-w-0">
            <Card className="flex flex-col lg:col-span-3">
              <CardHeader
                title="Lift vs control"
                description={
                  report.srm.mismatch ? (
                    <span className="font-medium text-warn">Not reliable until the traffic split is fixed.</span>
                  ) : (
                    `${Math.round((1 - report.alpha) * 1000) / 10}% confidence. Crossing 0 means no clear effect.`
                  )
                }
              />
              {/* Centered so the chart sits mid-card when the health card beside it is taller. */}
              <CardBody className={`flex flex-1 items-center ${report.srm.mismatch ? 'opacity-60' : ''}`}>
                <LiftForest report={report} />
              </CardBody>
            </Card>
            <div className="lg:col-span-2">
              <HealthCard report={report} />
            </div>
            {report.guardrails.length > 0 && (
              <div className="lg:col-span-5">
                <GuardrailsCard report={report} />
              </div>
            )}
            <Card className="lg:col-span-5">
              <CardHeader title="Lift over time" description={report.sequential ? 'Cumulative. The band is valid at every point.' : 'Cumulative. The band narrows as data arrives.'} />
              <CardBody>
                <LiftOverTime points={points} variants={report.variants.map((v) => v.variant)} />
              </CardBody>
            </Card>
            <div className="lg:col-span-5">
              <VariantsTable report={report} />
            </div>
            {Object.keys(report.segments).length > 0 && (
              <div className="lg:col-span-5">
                <SegmentsCard report={report} />
              </div>
            )}
          </div>
        )}

        {tab === 'setup' && (
          <div className="grid items-start gap-4 lg:grid-cols-5 [&>*]:min-w-0">
            <div className="lg:col-span-3">
              <ConfigCard flag={flag} onSaved={saved} />
            </div>
            <div className="space-y-4 lg:col-span-2">
              <LifecycleCard flag={flag} report={report} onSaved={saved} />
              <Planner flag={flag} report={report} />
              <Playground flag={flag} />
            </div>
          </div>
        )}

        {tab === 'history' && <Timeline entries={audit} />}
      </motion.div>
    </div>
  );
}

/** Confetti for a "Ship it" verdict only, once per experiment per session, so it stays special. */
function useCelebration(flagKey: string, report: ExperimentReport | null) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || report?.verdict.kind !== 'SHIP') return;
    fired.current = true;
    const key = `verdict.celebrated.${flagKey}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Storage unavailable: celebrate anyway.
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => {
      const colors = ['#0f8a3c', '#3ccf6e', '#2a78d6', '#eda100'];
      confetti({ particleCount: 70, spread: 70, startVelocity: 38, origin: { x: 0.3, y: 0.35 }, colors, disableForReducedMotion: true });
      confetti({ particleCount: 70, spread: 70, startVelocity: 38, origin: { x: 0.7, y: 0.35 }, colors, disableForReducedMotion: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [flagKey, report]);
}

function CopyKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content={copied ? 'Copied' : 'Copy key'}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy key"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="text-good" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

function Timeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-16 text-center text-fg-muted">No changes yet.</p>;
  }
  return (
    <Card>
      <CardBody className="pt-6">
        <ol className="relative">
          {entries.map((e, i) => (
            <li key={e.id} className="relative flex gap-4 pb-6 last:pb-0">
              {i < entries.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-24px)] w-px bg-border" />}
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-bg-subtle text-fg-muted ring-1 ring-border">
                <History className="size-3.5" />
              </span>
              <div className="min-w-0 pt-1">
                <div className="text-[15px]">{e.summary}</div>
                <div className="mt-0.5 text-[13px] text-fg-faint">
                  v{e.version} · {timeAgo(e.ts)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-24 animate-pulse rounded bg-bg-subtle" />
      <div className="h-10 w-72 animate-pulse rounded-lg bg-bg-subtle" />
      <div className="h-44 animate-pulse rounded-3xl bg-bg-subtle" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-bg-subtle" />
        ))}
      </div>
    </div>
  );
}
