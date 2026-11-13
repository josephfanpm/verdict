import type { UserRow } from './aggregate.js';
import { compareStats } from './analyze.js';
import { emptyArmStats, type ArmStats, type SequentialOptions } from './stats.js';
import type { FlagConfig } from './types.js';

export interface TimeseriesPoint {
  /** End of the bucket (inclusive). Every number below is cumulative up to here. */
  ts: number;
  exposures: Record<string, number>;
  rates: Record<string, number>;
  /** Relative lift vs control and its confidence interval, per treatment. */
  lift: Record<string, { value: number; low: number; high: number } | null>;
}

/**
 * Cumulative exposures, goal metric, and lift over time.
 *
 * With sequential testing on, the band at every point is an always-valid
 * interval, so the chart can be read at any date without peeking error. With
 * it off, each band is a fixed-horizon interval that is only honest at the
 * planned sample; watching it narrow shows why an early result can't be trusted.
 *
 * Conversions are added at the moment they happened. Per-user averages and
 * ratios are added when the user was exposed, using their final value.
 */
export function timeseries(flag: FlagConfig, rows: UserRow[], alpha: number, options: { buckets?: number; sequential?: SequentialOptions; cap?: number | null } = {}): TimeseriesPoint[] {
  if (rows.length === 0) return [];
  const buckets = options.buckets ?? 30;
  const keys = flag.variants.map((v) => v.key);
  const control = keys[0]!;
  const kind = flag.goal.kind;
  const cap = options.cap ?? null;

  // Two time-ordered streams per variant: users arriving, and their results landing.
  type Step = { at: number; y: number; d: number; arrival: boolean };
  const steps = new Map(keys.map((k) => [k, [] as Step[]]));
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const m = row.metrics[0]!;
    const list = steps.get(row.variant);
    if (!list || !m.complete) continue;
    const y = cap !== null ? Math.min(m.y, cap) : m.y;
    const landsAt = kind === 'conversion' ? m.firstAt : row.ts;
    list.push({ at: row.ts, y: 0, d: m.d, arrival: true });
    if (y !== 0 && landsAt !== null) list.push({ at: landsAt, y, d: m.d, arrival: false });
    start = Math.min(start, row.ts);
    end = Math.max(end, landsAt ?? row.ts);
  }
  if (!Number.isFinite(start)) return [];
  for (const list of steps.values()) list.sort((a, b) => a.at - b.at);

  const step = Math.max(1, Math.ceil((end - start) / buckets));
  const edges = [...new Set(Array.from({ length: buckets }, (_, i) => Math.min(end, start + step * (i + 1))))];

  const running = new Map(keys.map((k) => [k, emptyArmStats()]));
  const cursor = new Map(keys.map((k) => [k, 0]));

  return edges.map((t) => {
    for (const k of keys) {
      const list = steps.get(k)!;
      const stats = running.get(k)!;
      let i = cursor.get(k)!;
      for (; i < list.length && list[i]!.at <= t; i++) {
        const s = list[i]!;
        if (s.arrival) {
          stats.n += 1;
          stats.dSum += s.d;
          stats.dSumSq += s.d * s.d;
        } else {
          stats.converters += 1;
          stats.sum += s.y;
          stats.sumSq += s.y * s.y;
          stats.ydSum += s.y * s.d;
        }
      }
      cursor.set(k, i);
    }

    const value = (s: ArmStats) => (kind === 'ratio' ? (s.dSum === 0 ? 0 : s.sum / s.dSum) : s.n === 0 ? 0 : s.sum / s.n);
    const exposures = Object.fromEntries(keys.map((k) => [k, running.get(k)!.n]));
    const rates = Object.fromEntries(keys.map((k) => [k, value(running.get(k)!)]));
    const lift = Object.fromEntries(
      keys.slice(1).map((k) => {
        const c = compareStats(kind, running.get(control)!, running.get(k)!, alpha, options.sequential);
        return [k, c?.relativeLift != null && c.relativeLiftInterval ? { value: c.relativeLift, low: c.relativeLiftInterval[0], high: c.relativeLiftInterval[1] } : null];
      })
    );
    return { ts: t, exposures, rates, lift };
  });
}
