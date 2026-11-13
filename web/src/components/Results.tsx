import NumberFlow from '@number-flow/react';
import { CircleCheck, Minus, OctagonX, TrendingUp, TriangleAlert, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import type { ExperimentReport, MetricVariantResult, TimeseriesPoint } from '../api';
import { dayCount, metricValue, num, pct, PERCENT_FORMAT, pValue, seriesColor, shortDate, SIGNED_PERCENT_FORMAT, signedPct } from '../format';
import { cn } from '../lib/utils';
import { VERDICT, VerdictIcon } from '../verdict';
import { ProgressRing } from './ProgressRing';
import { Card, CardBody, CardHeader } from './ui/card';
import { Segmented } from './ui/segmented';
import { Tooltip } from './ui/tooltip';

export function VerdictHero({ report }: { report: ExperimentReport }) {
  const { verdict } = report;
  const meta = VERDICT[verdict.kind];
  return (
    <Card className={cn('overflow-hidden', verdict.kind === 'INVESTIGATE' && 'attention-border')}>
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:gap-6 sm:p-8" aria-live="polite">
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', bounce: 0.45, duration: 0.6 }}>
          <VerdictIcon kind={verdict.kind} size="lg" />
        </motion.div>
        <div className="min-w-0 flex-1">
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className={cn('text-[13px] font-semibold uppercase tracking-[0.06em]', meta.text)}
          >
            {meta.label}
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="mt-1 text-[22px] font-semibold leading-snug tracking-[-0.015em] sm:text-[26px]"
          >
            {verdict.headline}
          </motion.h2>
          {verdict.reasons.length > 0 && (
            <motion.ul
              initial="hidden"
              animate="show"
              variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.18 } } }}
              className="mt-4 space-y-2"
            >
              {verdict.reasons.map((r) => (
                <motion.li
                  key={r}
                  variants={{ hidden: { opacity: 0, y: 4 }, show: { opacity: 1, y: 0 } }}
                  className="flex gap-2.5 text-[14px] leading-relaxed text-fg-muted"
                >
                  <span className="mt-[9px] size-1 shrink-0 rounded-full bg-fg-faint" />
                  {r}
                </motion.li>
              ))}
            </motion.ul>
          )}
        </div>
      </div>
    </Card>
  );
}

export function StatTiles({ report, points }: { report: ExperimentReport; points: TimeseriesPoint[] }) {
  const treatments = report.variants.filter((v) => !v.isControl && v.comparison?.relativeLift != null);
  const best = report.verdict.winner
    ? treatments.find((t) => t.variant === report.verdict.winner)
    : treatments.reduce<(typeof treatments)[number] | undefined>(
        (a, b) => (!a || Math.abs(b.comparison!.relativeLift!) > Math.abs(a.comparison!.relativeLift!) ? b : a),
        undefined
      );
  const days = daysRemaining(report, points);
  const runtime =
    report.runtimeDays === null
      ? undefined
      : report.runtimeDays < report.minRuntimeDays
        ? `Day ${dayCount(report.runtimeDays)} of ${report.minRuntimeDays} minimum`
        : `${dayCount(report.runtimeDays)} days`;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Users" sub={runtime}>
        <NumberFlow value={report.totalExposures} />
      </Tile>
      <Tile
        label={best ? `Lift · ${best.variant}` : 'Lift'}
        sub={report.varianceReduction > 0 ? `${pct(report.varianceReduction, 0)} less noise` : undefined}
        hint={report.varianceReduction > 0 ? 'Adjusted for what each user did before the experiment' : undefined}
      >
        {best ? <NumberFlow value={best.comparison!.relativeLift!} format={SIGNED_PERCENT_FORMAT} /> : <span className="text-fg-faint">–</span>}
      </Tile>
      <Tile
        label="p-value"
        sub={report.sequential ? 'Safe to check anytime' : undefined}
        hint={report.sequential ? `Sequential test. Significant below ${report.alpha.toFixed(3)}` : `Significant below ${report.alpha.toFixed(3)}`}
      >
        {best ? (
          best.comparison!.pValue < 0.001 ? (
            '<0.001'
          ) : (
            <NumberFlow value={best.comparison!.pValue} format={{ maximumFractionDigits: 3, minimumFractionDigits: 3 }} />
          )
        ) : (
          <span className="text-fg-faint">–</span>
        )}
      </Tile>
      <Tile
        label="Planned sample"
        hint={
          report.requiredPerVariant
            ? `${num(report.requiredPerVariant)} users per variant${report.planSource === 'provisional' ? ' (estimate, locks at 1,000 control users)' : ' (locked)'}`
            : 'Needs 100 control users to plan'
        }
        aside={<ProgressRing value={report.progress} size={30} />}
        sub={report.progress >= 1 ? 'Complete' : days !== null ? `~${days} day${days === 1 ? '' : 's'} left` : undefined}
      >
        <NumberFlow value={report.progress} format={{ style: 'percent', maximumFractionDigits: 0 }} />
      </Tile>
    </div>
  );
}

/** Days until the smallest arm reaches the planned sample, at the recent arrival rate. */
function daysRemaining(report: ExperimentReport, points: TimeseriesPoint[]): number | null {
  if (!report.requiredPerVariant || report.progress >= 1 || points.length < 4) return null;
  const smallest = report.variants.reduce((a, b) => (b.analyzed < a.analyzed ? b : a));
  const recent = points.slice(-Math.ceil(points.length / 2));
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const perDay = ((last.exposures[smallest.variant] ?? 0) - (first.exposures[smallest.variant] ?? 0)) / ((last.ts - first.ts) / 86_400_000);
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  return Math.max(1, Math.ceil((report.requiredPerVariant - smallest.analyzed) / perDay));
}

function Tile({ label, hint, aside, sub, children }: { label: string; hint?: string; aside?: React.ReactNode; sub?: string; children: React.ReactNode }) {
  const body = (
    <div className="flex h-full flex-col justify-between rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[13px] text-fg-muted">{label}</span>
        {aside}
      </div>
      <div className="mt-3">
        <div className="tabular flex h-8 items-end text-[26px] font-semibold leading-none tracking-[-0.02em]">{children}</div>
        {/* Always reserve the caption line so numbers align across tiles. */}
        <div className="mt-1.5 h-4 truncate text-xs text-fg-faint">{sub}</div>
      </div>
    </div>
  );
  return hint ? (
    <Tooltip content={hint}>
      <div tabIndex={0} className="rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-ring">
        {body}
      </div>
    </Tooltip>
  ) : (
    body
  );
}

/** Relative lift with its interval, and a dot when it is significant. */
function LiftCell({ row }: { row: Pick<MetricVariantResult, 'comparison' | 'outcome'> }) {
  const c = row.comparison;
  if (c?.relativeLift == null) return <span className="text-fg-faint">–</span>;
  return (
    <div className="flex flex-col items-end">
      <span className="flex items-center gap-1.5 font-semibold">
        {row.outcome && row.outcome !== 'flat' && (
          <span
            className={cn('size-1.5 rounded-full', row.outcome === 'better' ? 'bg-good' : 'bg-bad')}
            aria-label={row.outcome === 'better' ? 'Significantly better' : 'Significantly worse'}
          />
        )}
        {signedPct(c.relativeLift)}
      </span>
      {c.relativeLiftInterval && (
        <span className="text-xs text-fg-faint">
          {signedPct(c.relativeLiftInterval[0])} to {signedPct(c.relativeLiftInterval[1])}
        </span>
      )}
    </div>
  );
}

const VALUE_HEADER = { conversion: 'Conversion', mean: 'Per user', ratio: 'Ratio' } as const;

export function VariantsTable({ report }: { report: ExperimentReport }) {
  return (
    <Card>
      <CardHeader title="Variants" description={`Goal: ${report.metric}`} />
      <CardBody className="px-0 pb-2 pt-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-faint">
                <th className="px-6 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 text-right font-medium">Users</th>
                <th className="px-3 py-2 text-right font-medium">{VALUE_HEADER[report.metricKind]}</th>
                <th className="px-3 py-2 text-right font-medium">Lift</th>
                <th className="px-6 py-2 text-right font-medium">p-value</th>
              </tr>
            </thead>
            <tbody>
              {report.variants.map((v, i) => {
                const c = v.comparison;
                return (
                  <tr key={v.variant} className="border-t border-border">
                    <td className="px-6 py-3.5">
                      <span className="flex items-center gap-2.5">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
                        <span className="font-medium">{v.variant}</span>
                        {v.isControl && <span className="rounded-full bg-neutral-bg px-2 py-0.5 text-[11px] font-medium text-fg-muted">Control</span>}
                      </span>
                    </td>
                    <td className="tabular px-3 py-3.5 text-right">
                      <NumberFlow value={v.exposures} />
                    </td>
                    <td className="tabular px-3 py-3.5 text-right">
                      {report.metricKind === 'conversion' ? (
                        <NumberFlow value={v.rate} format={{ ...PERCENT_FORMAT, minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                      ) : (
                        metricValue(report.metricKind, v.rate)
                      )}
                    </td>
                    <td className="tabular px-3 py-3.5 text-right">
                      <LiftCell row={v} />
                    </td>
                    <td className={cn('tabular px-6 py-3.5 text-right', c?.significant ? 'font-medium' : 'text-fg-muted')}>{c ? pValue(c.pValue) : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function Status({ tone, icon: Icon, children }: { tone: 'good' | 'bad' | 'warn' | 'neutral'; icon: LucideIcon; children: React.ReactNode }) {
  const tones = { good: 'bg-good-bg text-good', bad: 'bg-bad-bg text-bad', warn: 'bg-warn-bg text-warn', neutral: 'bg-neutral-bg text-fg-muted' };
  return (
    <span className={cn('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium', tones[tone])}>
      <Icon className="size-3.5" /> {children}
    </span>
  );
}

const GUARDRAIL_STATUS = {
  worse: { tone: 'bad', icon: OctagonX, label: 'Broken' },
  better: { tone: 'good', icon: TrendingUp, label: 'Improved' },
  flat: { tone: 'good', icon: CircleCheck, label: 'Held' },
} as const;

/** Metrics that must not get worse. One broken guardrail blocks a ship, however good the goal looks. */
export function GuardrailsCard({ report }: { report: ExperimentReport }) {
  if (report.guardrails.length === 0) return null;
  const broken = report.guardrails.some((g) => g.variants.some((v) => v.outcome === 'worse'));
  return (
    <Card className={cn(broken && 'attention-border')}>
      <CardHeader
        title="Guardrails"
        action={
          broken ? (
            <Status tone="bad" icon={OctagonX}>
              Broken
            </Status>
          ) : (
            <Status tone="good" icon={CircleCheck}>
              All held
            </Status>
          )
        }
      />
      <CardBody className="px-0 pb-2 pt-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-faint">
                <th className="px-6 py-2 font-medium">Metric</th>
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 text-right font-medium">Control</th>
                <th className="px-3 py-2 text-right font-medium">Variant</th>
                <th className="px-3 py-2 text-right font-medium">Change</th>
                <th className="px-6 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.guardrails.flatMap((g) => {
                const control = g.variants[0]!;
                return g.variants.slice(1).map((v, i) => {
                  const status = v.outcome ? GUARDRAIL_STATUS[v.outcome] : null;
                  return (
                    <tr key={`${g.label}-${v.variant}`} className="border-t border-border">
                      <td className="px-6 py-3.5 font-medium">
                        {i === 0 ? g.label : ''}
                        {i === 0 && <span className="ml-2 text-xs font-normal text-fg-faint">{g.metric.direction === 'decrease' ? 'lower is better' : 'higher is better'}</span>}
                      </td>
                      <td className="px-3 py-3.5">{v.variant}</td>
                      <td className="tabular px-3 py-3.5 text-right text-fg-muted">{metricValue(g.metric.kind, control.value)}</td>
                      <td className="tabular px-3 py-3.5 text-right">{metricValue(g.metric.kind, v.value)}</td>
                      <td className="tabular px-3 py-3.5 text-right">
                        <LiftCell row={v} />
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        {status ? (
                          <Status tone={status.tone} icon={status.icon}>
                            {status.label}
                          </Status>
                        ) : (
                          <Status tone="neutral" icon={Minus}>
                            No data
                          </Status>
                        )}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

/** Can the numbers be trusted? The split, double exposures, and whether the groups started out alike. */
export function HealthCard({ report }: { report: ExperimentReport }) {
  const { srm, health } = report;
  const p = srm.pValue < 0.0001 ? srm.pValue.toExponential(1) : srm.pValue.toFixed(3);
  const unhealthy = srm.mismatch || health.multipleExposures.flagged || health.preExperiment.flagged;
  return (
    <Card className={cn(unhealthy && 'attention-border')}>
      <CardHeader
        title="Data health"
        description={`Traffic split · p = ${p}`}
        action={
          unhealthy ? (
            <Status tone="warn" icon={TriangleAlert}>
              {srm.mismatch ? 'Mismatch' : 'Check'}
            </Status>
          ) : (
            <Status tone="good" icon={CircleCheck}>
              Healthy
            </Status>
          )
        }
      />
      <CardBody className="space-y-4">
        {report.variants.map((v, i) => {
          const observed = srm.observedShares[i] ?? 0;
          const expected = srm.expectedShares[i] ?? 0;
          return (
            <div key={v.variant}>
              <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                <span className="font-medium">{v.variant}</span>
                <span className="tabular text-fg-muted">
                  <span className="font-medium text-fg">{pct(observed)}</span> of {pct(expected)}
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-bg-subtle">
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: seriesColor(i) }}
                  initial={{ width: 0 }}
                  animate={{ width: pct(observed) }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.8, delay: i * 0.05 }}
                />
                <div className="absolute -inset-y-1 w-0.5 rounded-full bg-fg" style={{ left: `calc(${pct(expected)} - 1px)` }} title="Expected share" />
              </div>
            </div>
          );
        })}

        {health.srmByDay.length > 1 && (
          <div>
            <div className="mb-1.5 text-[13px] text-fg-muted">Split by day</div>
            <div className="flex gap-1">
              {health.srmByDay.map((d) => (
                <Tooltip key={d.day} content={`${shortDate(d.day)} · ${num(d.exposures.reduce((a, b) => a + b, 0))} users · p = ${pValue(d.pValue)}`}>
                  <span tabIndex={0} className={cn('h-5 min-w-1.5 flex-1 rounded-sm', d.mismatch ? 'bg-warn' : 'bg-good/50')} aria-label={`${shortDate(d.day)}: ${d.mismatch ? 'mismatch' : 'healthy'}`} />
                </Tooltip>
              ))}
            </div>
          </div>
        )}

        <dl className="divide-y divide-border border-t border-border text-[13px]">
          <HealthRow
            label="Seen in two variants"
            ok={!health.multipleExposures.flagged}
            value={health.multipleExposures.count === 0 ? 'None' : `${num(health.multipleExposures.count)} (${pct(health.multipleExposures.share)})`}
          />
          <HealthRow
            label="Before the experiment"
            ok={!health.preExperiment.flagged}
            value={!health.preExperiment.checked ? 'No history' : health.preExperiment.flagged ? 'Groups differ' : 'Groups match'}
          />
          {health.inProgress > 0 && <HealthRow label="Still converting" ok value={`${num(health.inProgress)} users`} />}
        </dl>
      </CardBody>
    </Card>
  );
}

function HealthRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  const Icon = ok ? CircleCheck : TriangleAlert;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium">
        <Icon className={cn('size-3.5', ok ? 'text-good' : 'text-warn')} />
        {value}
      </dd>
    </div>
  );
}

/** The goal split by a user attribute. For explaining a result, not for picking a winner. */
export function SegmentsCard({ report }: { report: ExperimentReport }) {
  const dimensions = Object.keys(report.segments);
  const [selected, setSelected] = useState(dimensions[0] ?? '');
  if (dimensions.length === 0) return null;
  const dimension = dimensions.includes(selected) ? selected : dimensions[0]!;
  const rows = report.segments[dimension] ?? [];
  const treatments = report.variants.filter((v) => !v.isControl).map((v) => v.variant);

  return (
    <Card>
      <CardHeader
        title="Segments"
        description="Exploratory"
        action={
          dimensions.length > 1 ? <Segmented label="Dimension" value={dimension} onChange={setSelected} options={dimensions.map((d) => ({ value: d, label: d }))} /> : undefined
        }
      />
      <CardBody className="px-0 pb-2 pt-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-faint">
                <th className="px-6 py-2 font-medium">{dimension}</th>
                <th className="px-3 py-2 text-right font-medium">Users</th>
                {treatments.map((t) => (
                  <th key={t} className="px-3 py-2 text-right font-medium last:pr-6">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.value} className="border-t border-border">
                  <td className="px-6 py-3.5">
                    <span className="flex items-center gap-2 font-medium">
                      {s.value}
                      {s.srm.mismatch && (
                        <Tooltip content={`Traffic split is off here (p = ${pValue(s.srm.pValue)})`}>
                          <span tabIndex={0} className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] text-warn">
                            <TriangleAlert className="size-3" /> Split
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                  <td className="tabular px-3 py-3.5 text-right">{num(s.exposures)}</td>
                  {treatments.map((t) => {
                    const row = s.variants.find((v) => v.variant === t);
                    return (
                      <td key={t} className="tabular px-3 py-3.5 text-right last:pr-6">
                        {row ? <LiftCell row={row} /> : <span className="text-fg-faint">–</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}
