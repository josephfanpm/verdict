import { compareProportions } from './stats.js';
import type { FlagConfig } from './types.js';

/** One user's exposure, and when (if ever) they first converted after it. */
export interface ExposureRow {
  variant: string;
  ts: number;
  convertedAt: number | null;
}

export interface TimeseriesPoint {
  /** End of the bucket (inclusive). Every number below is cumulative up to here. */
  ts: number;
  exposures: Record<string, number>;
  rates: Record<string, number>;
  /** Relative lift vs control and its confidence interval, per treatment. */
  lift: Record<string, { value: number; low: number; high: number } | null>;
}

/**
 * Cumulative exposures, conversion rates, and lift over time. Watching the
 * interval narrow is the honest way to show why an early result can't be
 * trusted yet: early on it is wide enough to include zero.
 */
export function timeseries(flag: FlagConfig, rows: ExposureRow[], alpha: number, buckets = 30): TimeseriesPoint[] {
  if (rows.length === 0) return [];
  const keys = flag.variants.map((v) => v.key);
  const control = keys[0]!;

  const start = Math.min(...rows.map((r) => r.ts));
  const end = Math.max(...rows.map((r) => r.convertedAt ?? r.ts));
  const step = Math.max(1, Math.ceil((end - start) / buckets));
  const edges = Array.from({ length: buckets }, (_, i) => Math.min(end, start + step * (i + 1)));

  const exposureTimes = new Map(keys.map((k) => [k, [] as number[]]));
  const conversionTimes = new Map(keys.map((k) => [k, [] as number[]]));
  for (const row of rows) {
    exposureTimes.get(row.variant)?.push(row.ts);
    if (row.convertedAt !== null) conversionTimes.get(row.variant)?.push(row.convertedAt);
  }
  for (const list of [...exposureTimes.values(), ...conversionTimes.values()]) list.sort((a, b) => a - b);

  const cursors = new Map<number[], number>();
  const countUpTo = (sorted: number[], t: number) => {
    let i = cursors.get(sorted) ?? 0;
    while (i < sorted.length && sorted[i]! <= t) i++;
    cursors.set(sorted, i);
    return i;
  };

  return [...new Set(edges)].map((t) => {
    const exposures: Record<string, number> = {};
    const conversions: Record<string, number> = {};
    for (const k of keys) {
      exposures[k] = countUpTo(exposureTimes.get(k)!, t);
      conversions[k] = countUpTo(conversionTimes.get(k)!, t);
    }
    const rates = Object.fromEntries(keys.map((k) => [k, exposures[k]! === 0 ? 0 : conversions[k]! / exposures[k]!]));
    const lift = Object.fromEntries(
      keys.slice(1).map((k) => {
        const c = compareProportions(
          { exposures: exposures[control]!, conversions: conversions[control]! },
          { exposures: exposures[k]!, conversions: conversions[k]! },
          alpha
        );
        return [k, c?.relativeLift != null && c.relativeLiftInterval ? { value: c.relativeLift, low: c.relativeLiftInterval[0], high: c.relativeLiftInterval[1] } : null];
      })
    );
    return { ts: t, exposures, rates, lift };
  });
}
