import { describe, expect, it } from 'vitest';
import {
  addObservation,
  chiSquarePValue,
  compareMeans,
  compareProportions,
  cuped,
  emptyArmStats,
  meanMoments,
  normalCdf,
  normalQuantile,
  ratioMoments,
  requiredSampleSize,
  requiredSampleSizeMean,
  sampleRatioMismatch,
  sequentialCritical,
  sequentialPValue,
  studentTCdf,
  studentTQuantile,
} from '../src/core/stats.js';

/** Small seeded generator so the simulated data is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe('Student t distribution', () => {
  it('matches critical values from a t table', () => {
    expect(studentTCdf(2.228139, 10)).toBeCloseTo(0.975, 5);
    expect(studentTCdf(-2.085963, 20)).toBeCloseTo(0.025, 5);
    expect(studentTCdf(12.7062, 1)).toBeCloseTo(0.975, 5);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 4);
    expect(studentTQuantile(0.95, 5)).toBeCloseTo(2.015048, 4);
  });

  it('approaches the normal distribution as degrees of freedom grow', () => {
    expect(studentTQuantile(0.975, 100_000)).toBeCloseTo(1.96, 3);
    expect(studentTCdf(1.959964, 2_000_000)).toBeCloseTo(0.975, 6);
  });
});

describe('compareMeans', () => {
  it('computes the Welch t-test', () => {
    // Unequal variances and sample sizes, where a pooled test would be wrong.
    const result = compareMeans({ n: 15, mean: 20.8, variance: 7.9 ** 2 }, { n: 12, mean: 27.1, variance: 3.4 ** 2 })!;
    const se = Math.sqrt(7.9 ** 2 / 15 + 3.4 ** 2 / 12);
    expect(result.zScore).toBeCloseTo(6.3 / se, 10);
    expect(result.method).toBe('t');
    // Welch-Satterthwaite gives about 19.9 degrees of freedom here, so p is close to 0.0125.
    expect(result.pValue).toBeGreaterThan(0.011);
    expect(result.pValue).toBeLessThan(0.014);
    expect(result.significant).toBe(true);
    expect(result.absoluteInterval[0]).toBeGreaterThan(0);
  });

  it('needs at least two users per arm', () => {
    expect(compareMeans({ n: 1, mean: 1, variance: 0 }, { n: 50, mean: 1, variance: 1 })).toBeNull();
  });
});

describe('ratioMoments', () => {
  it('estimates a ratio of totals, not an average of per-user ratios', () => {
    const arm = emptyArmStats();
    addObservation(arm, 100, 1); // one order worth 100
    addObservation(arm, 20, 4); // four orders worth 20 in total
    addObservation(arm, 0, 0);
    expect(ratioMoments(arm).mean).toBeCloseTo(120 / 5, 10);
  });
});

describe('requiredSampleSizeMean', () => {
  it('matches the textbook formula', () => {
    // n = 2 (1.96 + 0.8416)^2 * sd^2 / delta^2, with sd = 10 and delta = 1.
    expect(requiredSampleSizeMean(10, 10, 0.1)).toBe(1570);
    expect(requiredSampleSizeMean(0, 10, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sequential testing', () => {
  it('demands more evidence than a fixed-horizon test at every sample size', () => {
    for (const n of [200, 2_000, 20_000, 200_000]) {
      expect(sequentialCritical(n, 0.05, 20_000)).toBeGreaterThan(1.96);
    }
  });

  it('agrees with itself: the p-value crosses alpha exactly at the critical value', () => {
    const z = sequentialCritical(8_000, 0.05, 20_000);
    expect(sequentialPValue(z, 8_000, 0.05, 20_000)).toBeCloseTo(0.05, 10);
    expect(sequentialPValue(0, 8_000, 0.05, 20_000)).toBe(1);
  });

  it('keeps false positives under alpha when an A/A test is checked after every batch', () => {
    const random = rng(7);
    const experiments = 400;
    const sequential = { tuning: 8_000 };
    let fixedHorizonCalls = 0;
    let sequentialCalls = 0;
    for (let e = 0; e < experiments; e++) {
      let a = 0;
      let b = 0;
      let fixed = false;
      let always = false;
      for (let n = 1; n <= 4_000; n++) {
        if (random() < 0.1) a++;
        if (random() < 0.1) b++;
        if (n % 200 === 0) {
          const control = { exposures: n, conversions: a };
          const treatment = { exposures: n, conversions: b };
          fixed ||= compareProportions(control, treatment)!.significant;
          always ||= compareProportions(control, treatment, 0.05, sequential)!.significant;
        }
      }
      if (fixed) fixedHorizonCalls++;
      if (always) sequentialCalls++;
    }
    expect(fixedHorizonCalls / experiments).toBeGreaterThan(0.15); // peeking breaks the ordinary test
    expect(sequentialCalls / experiments).toBeLessThan(0.05); // and not the sequential one
  });
});

describe('cuped', () => {
  it('removes predictable noise without moving the treatment effect', () => {
    const random = rng(11);
    const control = emptyArmStats();
    const treatment = emptyArmStats();
    for (let i = 0; i < 20_000; i++) {
      for (const [arm, effect] of [
        [control, 0],
        [treatment, 2],
      ] as const) {
        const habit = random() * 100; // what the user did before the experiment
        addObservation(arm, habit + effect + (random() - 0.5) * 20, 0, habit);
      }
    }
    const raw = [meanMoments(control), meanMoments(treatment)];
    const adjusted = cuped([control, treatment])!;

    expect(adjusted.varianceReduction).toBeGreaterThan(0.9);
    expect(adjusted.adjusted[1]!.variance).toBeLessThan(raw[1]!.variance * 0.1);
    // The estimated effect is still the true effect of 2, now with a much tighter interval.
    expect(adjusted.adjusted[1]!.mean - adjusted.adjusted[0]!.mean).toBeCloseTo(2, 0);
    const before = compareMeans(raw[0]!, raw[1]!)!;
    const after = compareMeans(adjusted.adjusted[0]!, adjusted.adjusted[1]!)!;
    expect(after.absoluteInterval[1] - after.absoluteInterval[0]).toBeLessThan((before.absoluteInterval[1] - before.absoluteInterval[0]) / 3);
  });

  it('does nothing when there is no pre-experiment data', () => {
    const arm = () => {
      const stats = emptyArmStats();
      for (let i = 0; i < 50; i++) addObservation(stats, i % 2);
      return stats;
    };
    expect(cuped([arm(), arm()])).toBeNull();
  });
});
