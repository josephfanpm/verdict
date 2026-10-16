import { describe, expect, it } from 'vitest';
import { chiSquarePValue, compareProportions, normalCdf, normalQuantile, requiredSampleSize, sampleRatioMismatch } from '../src/core/stats.js';

describe('normal distribution', () => {
  it('matches standard table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
  });

  it('round-trips quantile and cdf', () => {
    for (const p of [0.0001, 0.01, 0.3, 0.5, 0.9, 0.9999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    }
  });
});

describe('chiSquarePValue', () => {
  it('matches critical values from a chi-square table', () => {
    expect(chiSquarePValue(3.841459, 1)).toBeCloseTo(0.05, 5);
    expect(chiSquarePValue(5.991465, 2)).toBeCloseTo(0.05, 5);
    expect(chiSquarePValue(10.82757, 1)).toBeCloseTo(0.001, 5);
    expect(chiSquarePValue(0, 3)).toBe(1);
  });
});

describe('compareProportions', () => {
  it('computes the two-proportion z-test', () => {
    const result = compareProportions({ exposures: 10_000, conversions: 1_000 }, { exposures: 10_000, conversions: 1_100 })!;
    expect(result.controlRate).toBe(0.1);
    expect(result.treatmentRate).toBe(0.11);
    expect(result.relativeLift).toBeCloseTo(0.1, 10);
    expect(result.zScore).toBeCloseTo(2.3066, 3);
    expect(result.pValue).toBeCloseTo(0.0211, 3);
    expect(result.significant).toBe(true);
  });

  it('puts the point estimate inside its confidence interval', () => {
    const result = compareProportions({ exposures: 5_000, conversions: 400 }, { exposures: 5_000, conversions: 430 })!;
    const [low, high] = result.relativeLiftInterval!;
    expect(low).toBeLessThan(result.relativeLift!);
    expect(high).toBeGreaterThan(result.relativeLift!);
    expect(low).toBeLessThan(0); // not significant, so the interval spans zero
    expect(result.significant).toBe(false);
  });

  it('handles empty arms and zero conversions', () => {
    expect(compareProportions({ exposures: 0, conversions: 0 }, { exposures: 10, conversions: 1 })).toBeNull();
    const zero = compareProportions({ exposures: 100, conversions: 0 }, { exposures: 100, conversions: 0 })!;
    expect(zero.pValue).toBe(1);
    expect(zero.relativeLift).toBeNull();
  });
});

describe('requiredSampleSize', () => {
  it('matches the textbook formula for a 10% baseline and 10% relative lift', () => {
    expect(Math.abs(requiredSampleSize(0.1, 0.1) - 14_751)).toBeLessThanOrEqual(2);
  });

  it('needs more users for smaller effects', () => {
    expect(requiredSampleSize(0.1, 0.05)).toBeGreaterThan(requiredSampleSize(0.1, 0.1) * 3.5);
  });

  it('returns Infinity when the plan is impossible', () => {
    expect(requiredSampleSize(0, 0.1)).toBe(Number.POSITIVE_INFINITY);
    expect(requiredSampleSize(0.95, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sampleRatioMismatch', () => {
  it('passes a healthy split', () => {
    expect(sampleRatioMismatch([5_000, 5_040], [50, 50]).mismatch).toBe(false);
  });

  it('flags a split that is too far off to be chance', () => {
    const result = sampleRatioMismatch([5_000, 4_500], [50, 50]);
    expect(result.statistic).toBeCloseTo(26.3158, 3);
    expect(result.mismatch).toBe(true);
  });

  it('respects unequal weights', () => {
    expect(sampleRatioMismatch([8_000, 2_000], [80, 20]).mismatch).toBe(false);
    expect(sampleRatioMismatch([5_000, 5_000], [80, 20]).mismatch).toBe(true);
  });
});
