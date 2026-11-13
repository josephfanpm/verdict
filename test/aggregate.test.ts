import { describe, expect, it } from 'vitest';
import { buildInput, capFor, collect, summarize, type EventRecord, type ExposureRecord } from '../src/core/aggregate.js';
import { analyze } from '../src/core/analyze.js';
import { normalizeFlag, type FlagInput } from '../src/core/flag.js';
import { timeseries } from '../src/core/timeseries.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 10);
const NOW = T0 + 30 * DAY;

function flag(overrides: Partial<FlagInput> = {}) {
  return normalizeFlag({ key: 'exp', enabled: true, primaryMetric: 'purchase', ...overrides });
}

const exposure = (unit: string, variant: string, ts = T0, extra: Partial<ExposureRecord> = {}): ExposureRecord => ({ unit, variant, ts, ...extra });
const event = (unit: string, name: string, ts: number, value: number | null = null): EventRecord => ({ unit, name, value, ts });

describe('collect', () => {
  it('only counts events at or after exposure', () => {
    const f = flag();
    const { rows } = collect(f, [exposure('u1', 'control'), exposure('u2', 'treatment')], [event('u1', 'purchase', T0 - HOUR), event('u2', 'purchase', T0 + HOUR)], NOW);
    expect(rows.find((r) => r.variant === 'control')!.metrics[0]!.y).toBe(0);
    expect(rows.find((r) => r.variant === 'treatment')!.metrics[0]!.y).toBe(1);
  });

  it('keeps events before exposure as the pre-experiment value, inside the lookback window', () => {
    const f = flag({ preExperimentDays: 14 });
    const { rows } = collect(f, [exposure('recent', 'control'), exposure('old', 'control')], [event('recent', 'purchase', T0 - 3 * DAY), event('old', 'purchase', T0 - 40 * DAY)], NOW);
    expect(rows.map((r) => r.metrics[0]!.x)).toEqual([1, 0]);
  });

  it('ignores events after the conversion window closes', () => {
    const f = flag({ goal: { event: 'purchase', windowHours: 24 } });
    const { rows } = collect(f, [exposure('fast', 'control'), exposure('slow', 'control')], [event('fast', 'purchase', T0 + 2 * HOUR), event('slow', 'purchase', T0 + 30 * HOUR)], NOW);
    expect(rows.map((r) => r.metrics[0]!.y)).toEqual([1, 0]);
  });

  it('leaves users out of a metric while their conversion window is still open', () => {
    const f = flag({ goal: { event: 'purchase', windowHours: 72 } });
    const now = T0 + 5 * DAY;
    const collected = collect(f, [exposure('done', 'control', T0), exposure('open', 'treatment', now - 10 * HOUR)], [], now);
    const input = buildInput(f, collected);
    expect(input.goal.map((a) => a.n)).toEqual([1, 0]);
    expect(input.inProgress).toBe(1);
    // The split check still sees both exposures.
    expect(input.exposures).toEqual([1, 1]);
  });

  it('drops users seen in two variants and counts them', () => {
    const f = flag();
    const collected = collect(
      f,
      [
        exposure('clean', 'control'),
        // The same person, bucketed twice under two ids that were later linked.
        exposure('linked', 'control'),
        exposure('linked', 'treatment', T0 + HOUR),
        // The same id reported in a second variant.
        exposure('flipped', 'treatment', T0, { conflict: true }),
      ],
      [event('linked', 'purchase', T0 + 2 * HOUR)],
      NOW
    );
    expect(collected.rows.map((r) => r.variant)).toEqual(['control']);
    expect(collected.multipleExposures).toBe(2);
  });

  it('adds up values for per-user metrics and counts the denominator for ratios', () => {
    const f = flag({ goal: { event: 'order', kind: 'ratio', denominatorEvent: 'session' } });
    const { rows } = collect(
      f,
      [exposure('u1', 'control')],
      [event('u1', 'order', T0 + HOUR, 30), event('u1', 'order', T0 + 2 * HOUR, 12.5), event('u1', 'session', T0 + HOUR), event('u1', 'session', T0 + DAY), event('u1', 'session', T0 + 2 * DAY)],
      NOW
    );
    expect(rows[0]!.metrics[0]).toMatchObject({ y: 42.5, d: 3 });
  });

  it('reports exposures per day for the day-by-day split check', () => {
    const f = flag();
    const { daily, firstExposureAt, lastExposureAt } = collect(f, [exposure('a', 'control', T0), exposure('b', 'treatment', T0 + HOUR), exposure('c', 'control', T0 + DAY)], [], NOW);
    expect(daily.map((d) => d.exposures)).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(lastExposureAt! - firstExposureAt!).toBe(DAY);
  });
});

describe('capping', () => {
  it('stops one very large order from deciding a revenue test', () => {
    const f = flag({ goal: { event: 'order', kind: 'mean', capPercentile: 0.99 }, cuped: false, sequential: false });
    const exposures: ExposureRecord[] = [];
    const events: EventRecord[] = [];
    for (let i = 0; i < 4_000; i++) {
      const variant = i % 2 === 0 ? 'control' : 'treatment';
      exposures.push(exposure(`u${i}`, variant));
      if (i % 5 < 2) events.push(event(`u${i}`, 'order', T0 + HOUR, 20 + (i % 13)));
    }
    // One control user places an order 2,500x the typical size.
    events.push(event('u0', 'order', T0 + 2 * HOUR, 60_000));

    const collected = collect(f, exposures, events, NOW);
    const cap = capFor(f.goal, collected.rows, 0)!;
    expect(cap).toBeLessThan(100);

    const uncapped = summarize(f, collected.rows, 0, null);
    const capped = summarize(f, collected.rows, 0, cap);
    expect(uncapped[0]!.sum / uncapped[0]!.n).toBeGreaterThan(2 * (uncapped[1]!.sum / uncapped[1]!.n));
    expect(capped[0]!.sum / capped[0]!.n).toBeCloseTo(capped[1]!.sum / capped[1]!.n, 0);
    // With the cap, the whale no longer manufactures a "significant" difference.
    expect(analyze(f, buildInput(f, collected)).variants[1]!.outcome).toBe('flat');
  });
});

describe('buildInput', () => {
  it('splits the goal by each recorded dimension', () => {
    const f = flag({ dimensions: ['country'] });
    const collected = collect(
      f,
      [
        exposure('a', 'control', T0, { attributes: { country: 'US' } }),
        exposure('b', 'treatment', T0, { attributes: { country: 'US' } }),
        exposure('c', 'treatment', T0, { attributes: { country: 'CA' } }),
        exposure('d', 'control', T0),
      ],
      [event('b', 'purchase', T0 + HOUR)],
      NOW
    );
    const { segments } = buildInput(f, collected);
    const us = segments!.country!.find((s) => s.value === 'US')!;
    expect(us.exposures).toEqual([1, 1]);
    expect(us.goal.map((a) => a.converters)).toEqual([0, 1]);
    expect(segments!.country!.map((s) => s.value).sort()).toEqual(['(not set)', 'CA', 'US']);
  });
});

describe('timeseries', () => {
  it('draws a wider, always-valid band when sequential testing is on', () => {
    const f = flag();
    const exposures: ExposureRecord[] = [];
    const events: EventRecord[] = [];
    for (let i = 0; i < 6_000; i++) {
      const variant = i % 2 === 0 ? 'control' : 'treatment';
      const ts = T0 + i * 60_000;
      exposures.push(exposure(`u${i}`, variant, ts));
      if (i % (variant === 'control' ? 10 : 8) < 1) events.push(event(`u${i}`, 'purchase', ts + HOUR));
    }
    const { rows } = collect(f, exposures, events, NOW);
    const fixed = timeseries(f, rows, 0.05);
    const sequential = timeseries(f, rows, 0.05, { sequential: { tuning: 6_000 } });

    expect(fixed).toHaveLength(sequential.length);
    const last = fixed[fixed.length - 1]!;
    expect(last.exposures).toEqual({ control: 3_000, treatment: 3_000 });
    fixed.forEach((point, i) => {
      const a = point.lift.treatment;
      const b = sequential[i]!.lift.treatment;
      // Before the first conversion lands there is no interval to compare.
      if (!a || !b || a.high === a.low) return;
      expect(b.value).toBeCloseTo(a.value, 10);
      expect(b.high - b.low).toBeGreaterThan(a.high - a.low);
    });
  });
});
