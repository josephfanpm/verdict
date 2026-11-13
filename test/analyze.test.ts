import { describe, expect, it } from 'vitest';
import type { AnalysisInput } from '../src/core/aggregate.js';
import { analyze, inputFromCounts, MIN_CONTROL_FOR_LOCK, planToLock } from '../src/core/analyze.js';
import { normalizeFlag, type FlagInput } from '../src/core/flag.js';
import { addObservation, armFromCounts, emptyArmStats, type ArmStats } from '../src/core/stats.js';
import type { FlagConfig } from '../src/core/types.js';

/** A classic fixed-horizon experiment: read once, at the planned sample size. */
function fixedFlag(overrides: Partial<FlagInput> = {}): FlagConfig {
  return normalizeFlag({ key: 'exp', enabled: true, salt: 's', primaryMetric: 'purchase', minDetectableEffect: 0.1, sequential: false, ...overrides });
}

const baseFlag = fixedFlag();

function counts(control: [number, number], treatment: [number, number]) {
  return [
    { variant: 'control', exposures: control[0], conversions: control[1] },
    { variant: 'treatment', exposures: treatment[0], conversions: treatment[1] },
  ];
}

/** Counts for the goal plus one guardrail, with optional run length. */
function input(flag: FlagConfig, goal: Array<[number, number]>, guardrail: Array<[number, number]> | null, extra: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    exposures: goal.map(([n]) => n),
    goal: goal.map(([n, c]) => armFromCounts(n, c)),
    guardrails: guardrail ? [guardrail.map(([n, c]) => armFromCounts(n, c))] : flag.guardrails.map(() => goal.map(() => armFromCounts(0, 0))),
    ...extra,
  };
}

describe('analyze', () => {
  it('reports NOT_STARTED with no data', () => {
    expect(analyze(baseFlag, []).verdict.kind).toBe('NOT_STARTED');
  });

  it('says SHIP for a significant win at full sample', () => {
    const report = analyze(baseFlag, counts([20_000, 2_000], [20_000, 2_300]));
    expect(report.verdict.kind).toBe('SHIP');
    expect(report.verdict.winner).toBe('treatment');
    expect(report.progress).toBe(1);
  });

  it('says KEEP_RUNNING for an early win, to avoid peeking', () => {
    const report = analyze(baseFlag, counts([3_000, 300], [3_000, 370]));
    expect(report.variants[1]!.comparison!.significant).toBe(true);
    expect(report.verdict.kind).toBe('KEEP_RUNNING');
    expect(report.verdict.reasons.join(' ')).toMatch(/peeking/);
  });

  it("says DON'T SHIP for significant harm, even before full sample", () => {
    expect(analyze(baseFlag, counts([5_000, 1_000], [5_000, 850])).verdict.kind).toBe('DONT_SHIP');
  });

  it('says NO_DIFFERENCE for a flat result at full sample', () => {
    expect(analyze(baseFlag, counts([20_000, 2_000], [20_000, 2_010])).verdict.kind).toBe('NO_DIFFERENCE');
  });

  it('says INVESTIGATE on a sample ratio mismatch, even if the lift looks great', () => {
    const report = analyze(baseFlag, counts([20_000, 2_000], [17_000, 2_500]));
    expect(report.srm.mismatch).toBe(true);
    expect(report.verdict.kind).toBe('INVESTIGATE');
  });

  it('applies a Bonferroni correction with multiple treatments', () => {
    const flag = fixedFlag({
      variants: [
        { key: 'control', weight: 34 },
        { key: 'b', weight: 33 },
        { key: 'c', weight: 33 },
      ],
    });
    const report = analyze(flag, [
      { variant: 'control', exposures: 3_400, conversions: 340 },
      { variant: 'b', exposures: 3_300, conversions: 330 },
      { variant: 'c', exposures: 3_300, conversions: 335 },
    ]);
    expect(report.alpha).toBeCloseTo(0.025, 10);
    expect(report.verdict.reasons.join(' ')).toMatch(/Bonferroni/);
  });

  it('fills in variants that have no exposures yet', () => {
    const report = analyze(baseFlag, [{ variant: 'control', exposures: 10, conversions: 1 }]);
    expect(report.variants.map((v) => v.variant)).toEqual(['control', 'treatment']);
    expect(report.variants[1]!.exposures).toBe(0);
  });
});

describe('guardrails', () => {
  const flag = fixedFlag({ guardrails: [{ event: 'refund', direction: 'decrease' }] });

  it("says DON'T SHIP when the goal wins but a guardrail breaks", () => {
    // Purchases up 15%, refunds up 60%.
    const report = analyze(flag, input(flag, [[20_000, 2_000], [20_000, 2_300]], [[20_000, 400], [20_000, 640]]));
    expect(report.variants[1]!.outcome).toBe('better');
    expect(report.guardrails[0]!.variants[1]!.outcome).toBe('worse');
    expect(report.verdict.kind).toBe('DONT_SHIP');
    expect(report.verdict.headline).toMatch(/guardrail refund/);
    expect(report.verdict.winner).toBeUndefined();
  });

  it('ships when every guardrail holds, and says so', () => {
    const report = analyze(flag, input(flag, [[20_000, 2_000], [20_000, 2_300]], [[20_000, 400], [20_000, 410]]));
    expect(report.verdict.kind).toBe('SHIP');
    expect(report.verdict.reasons.join(' ')).toMatch(/Guardrails held: refund/);
  });

  it('reads direction correctly: fewer refunds is an improvement, not harm', () => {
    const report = analyze(flag, input(flag, [[20_000, 2_000], [20_000, 2_300]], [[20_000, 640], [20_000, 400]]));
    expect(report.guardrails[0]!.variants[1]!.outcome).toBe('better');
    expect(report.verdict.kind).toBe('SHIP');
  });

  it('stops a treatment that only breaks a guardrail', () => {
    const report = analyze(flag, input(flag, [[5_000, 500], [5_000, 510]], [[5_000, 100], [5_000, 190]]));
    expect(report.verdict.kind).toBe('DONT_SHIP');
  });
});

describe('several treatments', () => {
  const flag = fixedFlag({
    variants: [
      { key: 'control', weight: 34 },
      { key: 'good', weight: 33 },
      { key: 'bad', weight: 33 },
    ],
  });

  it('names the loser in the headline when another treatment wins', () => {
    const report = analyze(flag, [
      { variant: 'control', exposures: 34_000, conversions: 3_400 },
      { variant: 'good', exposures: 33_000, conversions: 3_800 },
      { variant: 'bad', exposures: 33_000, conversions: 2_800 },
    ]);
    expect(report.verdict.kind).toBe('SHIP');
    expect(report.verdict.winner).toBe('good');
    expect(report.verdict.headline).toBe('Ship good, and drop bad.');
  });

  it('says which treatments can keep running when only one is harmful', () => {
    const report = analyze(flag, [
      { variant: 'control', exposures: 3_400, conversions: 340 },
      { variant: 'good', exposures: 3_300, conversions: 345 },
      { variant: 'bad', exposures: 3_300, conversions: 240 },
    ]);
    expect(report.verdict.kind).toBe('DONT_SHIP');
    expect(report.verdict.reasons.join(' ')).toMatch(/Still undecided: good/);
  });
});

describe('minimum runtime', () => {
  it('holds a fully powered win until users have been enrolled for long enough', () => {
    const data = inputFromCounts(baseFlag, counts([20_000, 2_000], [20_000, 2_300]));
    const early = analyze(baseFlag, { ...data, runtimeDays: 2 });
    expect(early.verdict.kind).toBe('KEEP_RUNNING');
    expect(early.verdict.reasons.join(' ')).toMatch(/2 of the minimum 7 days/);
    expect(analyze(baseFlag, { ...data, runtimeDays: 7 }).verdict.kind).toBe('SHIP');
  });

  it('does not delay acting on harm', () => {
    const data = inputFromCounts(baseFlag, counts([5_000, 1_000], [5_000, 850]));
    expect(analyze(baseFlag, { ...data, runtimeDays: 1 }).verdict.kind).toBe('DONT_SHIP');
  });

  it('does not call "no difference" before the minimum runtime either', () => {
    const data = inputFromCounts(baseFlag, counts([20_000, 2_000], [20_000, 2_010]));
    expect(analyze(baseFlag, { ...data, runtimeDays: 3 }).verdict.kind).toBe('KEEP_RUNNING');
  });
});

describe('sequential testing', () => {
  const flag = fixedFlag({ sequential: true });

  it('can ship before the planned sample when the evidence is strong enough', () => {
    // 43% of the planned sample, but far past the always-valid threshold.
    const report = analyze(flag, { ...inputFromCounts(flag, counts([6_000, 600], [6_000, 760])), runtimeDays: 8 });
    expect(report.progress).toBeLessThan(1);
    expect(report.variants[1]!.comparison!.method).toBe('sequential');
    expect(report.verdict.kind).toBe('SHIP');
    expect(report.verdict.reasons.join(' ')).toMatch(/valid at any sample size/);
  });

  it('is stricter than a fixed-horizon test on the same data', () => {
    // p = 0.021 fixed-horizon: significant once, not significant under continuous monitoring.
    const data = counts([10_000, 1_000], [10_000, 1_100]);
    expect(analyze(baseFlag, data).variants[1]!.comparison!.significant).toBe(true);
    const sequential = analyze(flag, data).variants[1]!.comparison!;
    expect(sequential.significant).toBe(false);
    expect(sequential.pValue).toBeGreaterThan(0.021);
  });

  it('still waits for the minimum runtime', () => {
    const report = analyze(flag, { ...inputFromCounts(flag, counts([6_000, 600], [6_000, 760])), runtimeDays: 1.5 });
    expect(report.verdict.kind).toBe('KEEP_RUNNING');
    expect(report.verdict.reasons.join(' ')).not.toMatch(/peeking/);
  });
});

describe('sample plan', () => {
  it('uses a locked plan instead of re-deriving the target from the data', () => {
    const locked = fixedFlag({ plan: { baseline: 0.1, requiredPerVariant: 14_751, source: 'stated', lockedAt: 1 } });
    // The observed control rate (20%) would imply a much smaller sample; the plan must not follow it.
    const report = analyze(locked, counts([5_000, 1_000], [5_000, 1_010]));
    expect(report.requiredPerVariant).toBe(14_751);
    expect(report.planSource).toBe('locked');
    expect(analyze(baseFlag, counts([5_000, 1_000], [5_000, 1_010])).planSource).toBe('provisional');
  });

  it('locks from a stated baseline immediately, and from data only once control is large enough', () => {
    const stated = planToLock(fixedFlag({ plan: { baseline: 0.1 } }), null, 99)!;
    expect(Math.abs(stated.requiredPerVariant! - 14_751)).toBeLessThanOrEqual(2);
    expect(stated).toMatchObject({ source: 'stated', lockedAt: 99 });

    expect(planToLock(baseFlag, armFromCounts(MIN_CONTROL_FOR_LOCK - 1, 99), 1)).toBeNull();
    const observed = planToLock(baseFlag, armFromCounts(MIN_CONTROL_FOR_LOCK, 100), 1)!;
    expect(observed).toMatchObject({ source: 'observed', baseline: 0.1 });
    expect(planToLock({ ...baseFlag, plan: observed }, armFromCounts(50_000, 9_000), 2)).toBeNull();
  });
});

describe('trust checks', () => {
  it('says INVESTIGATE when too many users were seen in two variants', () => {
    const data = { ...inputFromCounts(baseFlag, counts([20_000, 2_000], [20_000, 2_300])), multipleExposures: 900 };
    const report = analyze(baseFlag, data);
    expect(report.health.multipleExposures.flagged).toBe(true);
    expect(report.verdict.kind).toBe('INVESTIGATE');
    expect(report.verdict.headline).toMatch(/more than one variant/);
  });

  it('only mentions a handful of double-exposed users', () => {
    const report = analyze(baseFlag, { ...inputFromCounts(baseFlag, counts([20_000, 2_000], [20_000, 2_300])), multipleExposures: 12 });
    expect(report.verdict.kind).toBe('SHIP');
    expect(report.verdict.reasons.join(' ')).toMatch(/12 users seen in two variants were left out/);
  });

  it('says INVESTIGATE when the groups already differed before the experiment', () => {
    // Treatment users were already buying far more often before they saw anything.
    const arm = (n: number, conversions: number, priorBuyers: number): ArmStats => ({ ...armFromCounts(n, conversions), xSum: priorBuyers, xSumSq: priorBuyers });
    const flag = fixedFlag({ cuped: false });
    const report = analyze(flag, { exposures: [20_000, 20_000], goal: [arm(20_000, 2_000, 1_000), arm(20_000, 2_300, 1_400)], guardrails: [] });
    expect(report.health.preExperiment).toMatchObject({ checked: true, flagged: true });
    expect(report.verdict.kind).toBe('INVESTIGATE');
    expect(report.verdict.headline).toMatch(/before the experiment/);
  });

  it('passes the pre-experiment check when the groups started out alike', () => {
    const arm = (n: number, conversions: number, priorBuyers: number): ArmStats => ({ ...armFromCounts(n, conversions), xSum: priorBuyers, xSumSq: priorBuyers });
    const report = analyze(fixedFlag({ cuped: false }), { exposures: [20_000, 20_000], goal: [arm(20_000, 2_000, 1_000), arm(20_000, 2_300, 1_010)], guardrails: [] });
    expect(report.health.preExperiment).toMatchObject({ checked: true, flagged: false });
    expect(report.verdict.kind).toBe('SHIP');
  });
});

describe('metric types', () => {
  function revenueArm(n: number, buyerShare: number, orderSize: number): ArmStats {
    const stats = emptyArmStats();
    for (let i = 0; i < n; i++) addObservation(stats, i % Math.round(1 / buyerShare) === 0 ? orderSize + (i % 7) * 3 : 0);
    return stats;
  }

  it('decides a revenue-per-user goal with a t-test', () => {
    const flag = fixedFlag({ goal: { event: 'order', kind: 'mean' } });
    const report = analyze(flag, { exposures: [30_000, 30_000], goal: [revenueArm(30_000, 0.1, 40), revenueArm(30_000, 0.1, 48)], guardrails: [] });
    expect(report.metric).toBe('order value per user');
    expect(report.variants[1]!.comparison!.method).toBe('t');
    expect(report.variants[1]!.rate).toBeGreaterThan(report.variants[0]!.rate);
    expect(report.requiredPerVariant).not.toBeNull();
    expect(report.verdict.kind).toBe('SHIP');
  });

  it('treats a drop as the win when the goal is to decrease', () => {
    const flag = fixedFlag({ goal: { event: 'churn', direction: 'decrease' } });
    const report = analyze(flag, counts([20_000, 2_300], [20_000, 2_000]));
    expect(report.variants[1]!.outcome).toBe('better');
    expect(report.verdict.kind).toBe('SHIP');
  });
});

describe('segments', () => {
  it('breaks the goal down by segment and points at the segment where the split broke', () => {
    const flag = fixedFlag({ dimensions: ['browser'] });
    const segment = (value: string, control: [number, number], treatment: [number, number]) => ({
      value,
      exposures: [control[0], treatment[0]],
      goal: [armFromCounts(...control), armFromCounts(...treatment)],
    });
    const report = analyze(flag, {
      exposures: [20_000, 18_600],
      goal: [armFromCounts(20_000, 2_000), armFromCounts(18_600, 2_100)],
      guardrails: [],
      segments: { browser: [segment('chrome', [15_000, 1_500], [15_000, 1_700]), segment('safari', [5_000, 500], [3_600, 400])] },
    });
    expect(report.segments.browser!.map((s) => s.srm.mismatch)).toEqual([false, true]);
    expect(report.segments.browser![0]!.variants[1]!.comparison!.relativeLift).toBeCloseTo(0.1333, 3);
    expect(report.verdict.kind).toBe('INVESTIGATE');
    expect(report.verdict.reasons.join(' ')).toMatch(/Start with browser = safari/);
  });
});
