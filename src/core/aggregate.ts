import { addObservation, emptyArmStats, type ArmStats } from './stats.js';
import type { FlagConfig, MetricDef } from './types.js';

/** One logged exposure. `unit` is the user's canonical id after identity links are applied. */
export interface ExposureRecord {
  unit: string;
  variant: string;
  ts: number;
  attributes?: Record<string, string> | null;
  /** True when the same id was later reported in a different variant. */
  conflict?: boolean;
}

export interface EventRecord {
  unit: string;
  name: string;
  value: number | null;
  ts: number;
}

/** One user's result on one metric. */
export interface UserMetric {
  /** Metric value inside the conversion window. */
  y: number;
  /** Denominator count (ratio metrics). */
  d: number;
  /** The same metric measured before exposure (CUPED covariate and pre-experiment check). */
  x: number;
  /** When the user first fired the event after exposure. */
  firstAt: number | null;
  /** False while the user's conversion window is still open. */
  complete: boolean;
}

/** One user who can be analyzed: exposed to exactly one variant. Metric 0 is the goal, the rest are guardrails. */
export interface UserRow {
  variant: string;
  ts: number;
  dims: Record<string, string>;
  metrics: UserMetric[];
}

export interface Collected {
  rows: UserRow[];
  /** Logged exposures per variant, in flag.variants order. This is what the split check uses. */
  exposures: number[];
  /** Users seen in more than one variant. They are left out of the analysis. */
  multipleExposures: number;
  firstExposureAt: number | null;
  lastExposureAt: number | null;
  /** Exposures per UTC day per variant, oldest first. */
  daily: Array<{ day: number; exposures: number[] }>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Join exposures to events and reduce each user to one row. This is where the
 * counting rules live:
 *  - an event only counts if it happened at or after the user's first exposure
 *  - and inside the metric's conversion window, if it has one
 *  - a user seen in two variants is dropped, because their result belongs to neither
 */
export function collect(flag: FlagConfig, exposures: ExposureRecord[], events: EventRecord[], now: number): Collected {
  const variantIndex = new Map(flag.variants.map((v, i) => [v.key, i]));
  const metrics = [flag.goal, ...flag.guardrails];

  const counts = flag.variants.map(() => 0);
  const dailyMap = new Map<number, number[]>();
  let first: number | null = null;
  let last: number | null = null;

  const byUnit = new Map<string, { variant: string; ts: number; attributes: Record<string, string>; mixed: boolean }>();
  for (const e of exposures) {
    const index = variantIndex.get(e.variant);
    if (index === undefined) continue;
    counts[index]! += 1;
    const day = Math.floor(e.ts / DAY) * DAY;
    const bucket = dailyMap.get(day) ?? flag.variants.map(() => 0);
    bucket[index]! += 1;
    dailyMap.set(day, bucket);
    first = first === null ? e.ts : Math.min(first, e.ts);
    last = last === null ? e.ts : Math.max(last, e.ts);

    const seen = byUnit.get(e.unit);
    if (!seen) {
      byUnit.set(e.unit, { variant: e.variant, ts: e.ts, attributes: e.attributes ?? {}, mixed: e.conflict === true });
    } else {
      if (seen.variant !== e.variant || e.conflict) seen.mixed = true;
      if (e.ts < seen.ts) {
        seen.ts = e.ts;
        seen.attributes = e.attributes ?? seen.attributes;
      }
    }
  }

  const eventsByUnit = new Map<string, EventRecord[]>();
  for (const ev of events) {
    const list = eventsByUnit.get(ev.unit);
    if (list) list.push(ev);
    else eventsByUnit.set(ev.unit, [ev]);
  }

  const rows: UserRow[] = [];
  let multipleExposures = 0;
  const preWindow = flag.preExperimentDays * DAY;
  for (const [unit, e] of byUnit) {
    if (e.mixed) {
      multipleExposures += 1;
      continue;
    }
    const userEvents = eventsByUnit.get(unit) ?? [];
    rows.push({
      variant: e.variant,
      ts: e.ts,
      dims: e.attributes,
      metrics: metrics.map((m) => measure(m, e.ts, userEvents, now, preWindow)),
    });
  }

  const daily = [...dailyMap.entries()].sort((a, b) => a[0] - b[0]).map(([day, list]) => ({ day, exposures: list }));
  return { rows, exposures: counts, multipleExposures, firstExposureAt: first, lastExposureAt: last, daily };
}

function measure(metric: MetricDef, exposedAt: number, events: EventRecord[], now: number, preWindow: number): UserMetric {
  const windowEnd = metric.windowHours === null ? Number.POSITIVE_INFINITY : exposedAt + metric.windowHours * HOUR;
  const result: UserMetric = { y: 0, d: 0, x: 0, firstAt: null, complete: windowEnd <= now || metric.windowHours === null };

  for (const ev of events) {
    const inWindow = ev.ts >= exposedAt && ev.ts < windowEnd;
    if (ev.name === metric.event) {
      const amount = metric.kind === 'conversion' ? 1 : (ev.value ?? 1);
      if (inWindow) {
        result.y = metric.kind === 'conversion' ? 1 : result.y + amount;
        if (result.firstAt === null || ev.ts < result.firstAt) result.firstAt = ev.ts;
      } else if (ev.ts < exposedAt && ev.ts >= exposedAt - preWindow) {
        result.x = metric.kind === 'conversion' ? 1 : result.x + amount;
      }
    }
    if (metric.kind === 'ratio' && ev.name === metric.denominatorEvent && inWindow) result.d += 1;
  }
  return result;
}

/**
 * The value above which a metric is capped (winsorized). One user who spends
 * 100x the average can swing a revenue comparison on their own; capping keeps
 * them in the test without letting them decide it. The percentile is taken
 * over users with a non-zero value, pooled across arms so every arm gets the same cap.
 */
export function capFor(metric: MetricDef, rows: UserRow[], metricIndex: number): number | null {
  if (metric.kind === 'conversion' || metric.capPercentile === null || metric.capPercentile >= 1) return null;
  const values: number[] = [];
  for (const row of rows) {
    const m = row.metrics[metricIndex]!;
    if (m.complete && m.y > 0) values.push(m.y);
  }
  if (values.length < 20) return null;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(metric.capPercentile * values.length))]!;
}

/** Running sums per variant for one metric, in flag.variants order. Users with an open window are skipped. */
export function summarize(
  flag: FlagConfig,
  rows: UserRow[],
  metricIndex: number,
  cap: number | null,
  include: (row: UserRow) => boolean = () => true
): ArmStats[] {
  const index = new Map(flag.variants.map((v, i) => [v.key, i]));
  const arms = flag.variants.map(() => emptyArmStats());
  for (const row of rows) {
    if (!include(row)) continue;
    const m = row.metrics[metricIndex]!;
    if (!m.complete) continue;
    const y = cap !== null ? Math.min(m.y, cap) : m.y;
    const x = cap !== null ? Math.min(m.x, cap) : m.x;
    addObservation(arms[index.get(row.variant)!]!, y, m.d, x);
  }
  return arms;
}

export interface SegmentInput {
  value: string;
  exposures: number[];
  goal: ArmStats[];
}

/** Everything the decision engine needs, already reduced to sums. */
export interface AnalysisInput {
  /** Logged exposures per variant, in flag.variants order. */
  exposures: number[];
  goal: ArmStats[];
  guardrails: ArmStats[][];
  /** Days between the first and the most recent exposure. Omit to skip the runtime gate. */
  runtimeDays?: number | null;
  multipleExposures?: number;
  /** Users left out of the goal metric because their conversion window is still open. */
  inProgress?: number;
  daily?: Array<{ day: number; exposures: number[] }>;
  segments?: Record<string, SegmentInput[]>;
}

const MAX_SEGMENT_VALUES = 8;

export function buildInput(flag: FlagConfig, collected: Collected): AnalysisInput {
  const { rows } = collected;
  const metrics = [flag.goal, ...flag.guardrails];
  const caps = metrics.map((m, i) => capFor(m, rows, i));

  const segments: Record<string, SegmentInput[]> = {};
  for (const dimension of flag.dimensions) {
    const sizes = new Map<string, number>();
    for (const row of rows) {
      const value = row.dims[dimension] ?? '(not set)';
      sizes.set(value, (sizes.get(value) ?? 0) + 1);
    }
    const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
    const named = new Set(ranked.slice(0, MAX_SEGMENT_VALUES).map(([value]) => value));
    const labels = [...named, ...(ranked.length > MAX_SEGMENT_VALUES ? ['Other'] : [])];
    const labelOf = (row: UserRow) => {
      const value = row.dims[dimension] ?? '(not set)';
      return named.has(value) ? value : 'Other';
    };
    const variantIndex = new Map(flag.variants.map((v, i) => [v.key, i]));
    segments[dimension] = labels.map((value) => {
      const exposures = flag.variants.map(() => 0);
      for (const row of rows) if (labelOf(row) === value) exposures[variantIndex.get(row.variant)!]! += 1;
      return { value, exposures, goal: summarize(flag, rows, 0, caps[0]!, (row) => labelOf(row) === value) };
    });
  }

  const span = collected.firstExposureAt !== null && collected.lastExposureAt !== null ? collected.lastExposureAt - collected.firstExposureAt : null;
  return {
    exposures: collected.exposures,
    goal: summarize(flag, rows, 0, caps[0]!),
    guardrails: flag.guardrails.map((_, i) => summarize(flag, rows, i + 1, caps[i + 1]!)),
    runtimeDays: span === null ? null : span / DAY,
    multipleExposures: collected.multipleExposures,
    inProgress: rows.filter((r) => !r.metrics[0]!.complete).length,
    daily: collected.daily,
    segments,
  };
}
