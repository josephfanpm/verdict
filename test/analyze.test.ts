import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analyze.js';
import type { FlagConfig } from '../src/core/types.js';

const baseFlag: FlagConfig = {
  key: 'exp',
  description: '',
  enabled: true,
  salt: 's',
  rolloutPercent: 100,
  variants: [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ],
  defaultVariant: 'control',
  targeting: [],
  primaryMetric: 'purchase',
  minDetectableEffect: 0.1,
  version: 1,
};

function counts(control: [number, number], treatment: [number, number]) {
  return [
    { variant: 'control', exposures: control[0], conversions: control[1] },
    { variant: 'treatment', exposures: treatment[0], conversions: treatment[1] },
  ];
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
    const flag: FlagConfig = {
      ...baseFlag,
      variants: [
        { key: 'control', weight: 34 },
        { key: 'b', weight: 33 },
        { key: 'c', weight: 33 },
      ],
    };
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
