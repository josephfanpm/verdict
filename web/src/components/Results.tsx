import NumberFlow from '@number-flow/react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { ExperimentReport, TimeseriesPoint } from '../api';
import { num, pct, PERCENT_FORMAT, pValue, seriesColor, SIGNED_PERCENT_FORMAT, signedPct } from '../format';
import { cn } from '../lib/utils';
import { VERDICT, VerdictIcon } from '../verdict';
import { ProgressRing } from './ProgressRing';
import { Card, CardBody, CardHeader } from './ui/card';
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

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Users">
        <NumberFlow value={report.totalExposures} />
      </Tile>
      <Tile label={best ? `Lift · ${best.variant}` : 'Lift'}>
        {best ? <NumberFlow value={best.comparison!.relativeLift!} format={SIGNED_PERCENT_FORMAT} /> : <span className="text-fg-faint">–</span>}
      </Tile>
      <Tile label="p-value" hint={`Significant below ${report.alpha.toFixed(3)}`}>
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
        hint={report.requiredPerVariant ? `${num(report.requiredPerVariant)} users per variant` : 'Needs 100 control users to plan'}
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
  const smallest = report.variants.reduce((a, b) => (b.exposures < a.exposures ? b : a));
  const recent = points.slice(-Math.ceil(points.length / 2));
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const perDay = ((last.exposures[smallest.variant] ?? 0) - (first.exposures[smallest.variant] ?? 0)) / ((last.ts - first.ts) / 86_400_000);
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  return Math.max(1, Math.ceil((report.requiredPerVariant - smallest.exposures) / perDay));
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
        {sub && <div className="mt-1.5 text-xs text-fg-faint">{sub}</div>}
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
                <th className="px-3 py-2 text-right font-medium">Conversion</th>
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
                      <NumberFlow value={v.rate} format={{ ...PERCENT_FORMAT, minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                    </td>
                    <td className="tabular px-3 py-3.5 text-right">
                      {c?.relativeLift != null ? (
                        <div className="flex flex-col items-end">
                          <span className="flex items-center gap-1.5 font-semibold">
                            {c.significant && (
                              <span
                                className={cn('size-1.5 rounded-full', c.absoluteLift > 0 ? 'bg-good' : 'bg-bad')}
                                aria-label={c.absoluteLift > 0 ? 'Significant gain' : 'Significant loss'}
                              />
                            )}
                            {signedPct(c.relativeLift)}
                          </span>
                          <span className="text-xs text-fg-faint">
                            {signedPct(c.relativeLiftInterval![0])} to {signedPct(c.relativeLiftInterval![1])}
                          </span>
                        </div>
                      ) : (
                        <span className="text-fg-faint">–</span>
                      )}
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

export function SplitHealth({ report }: { report: ExperimentReport }) {
  const { srm } = report;
  const p = srm.pValue < 0.0001 ? srm.pValue.toExponential(1) : srm.pValue.toFixed(3);
  return (
    <Card className={cn(srm.mismatch && 'attention-border')}>
      <CardHeader
        title="Traffic split"
        description={`Observed vs configured · p = ${p}`}
        action={
          srm.mismatch ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warn-bg px-2.5 text-[13px] font-medium text-warn">
              <TriangleAlert className="size-3.5" /> Mismatch
            </span>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-good-bg px-2.5 text-[13px] font-medium text-good">
              <CircleCheck className="size-3.5" /> Healthy
            </span>
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
        <p className="flex items-center gap-2 pt-1 text-xs text-fg-faint">
          <span className="inline-block h-3 w-0.5 rounded-full bg-fg" /> Expected share
        </p>
      </CardBody>
    </Card>
  );
}
