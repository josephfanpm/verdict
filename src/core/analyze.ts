import { compareProportions, requiredSampleSize, sampleRatioMismatch, type Comparison, type SrmResult } from './stats.js';
import type { FlagConfig, VariantCounts } from './types.js';

export type VerdictKind = 'NOT_STARTED' | 'INVESTIGATE' | 'DONT_SHIP' | 'SHIP' | 'NO_DIFFERENCE' | 'KEEP_RUNNING';

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  reasons: string[];
  winner?: string;
}

export interface VariantResult extends VariantCounts {
  isControl: boolean;
  configuredWeight: number;
  rate: number;
  /** Comparison against control; null for the control itself or when there is no data. */
  comparison: Comparison | null;
}

export interface ExperimentReport {
  flagKey: string;
  metric: string;
  /** Significance threshold per comparison, after Bonferroni correction. */
  alpha: number;
  totalExposures: number;
  /** Users needed in each variant to reach the planned power, or null if unknown yet. */
  requiredPerVariant: number | null;
  /** 0..1, how far the smallest variant is toward requiredPerVariant. */
  progress: number;
  variants: VariantResult[];
  srm: SrmResult;
  verdict: Verdict;
}

const BASE_ALPHA = 0.05;
const POWER = 0.8;
/** Below this, the control's observed rate is too noisy to plan a sample size from. */
const MIN_CONTROL_FOR_PLANNING = 100;

/** Turn raw exposure and conversion counts into a decision a PM can act on. */
export function analyze(flag: FlagConfig, counts: VariantCounts[]): ExperimentReport {
  const byKey = new Map(counts.map((c) => [c.variant, c]));
  const rows = flag.variants.map((v) => byKey.get(v.key) ?? { variant: v.key, exposures: 0, conversions: 0 });
  const control = rows[0]!;

  // Comparing several treatments to one control multiplies the chances of a
  // fluke "win", so the per-comparison threshold is divided (Bonferroni).
  const comparisons = Math.max(1, flag.variants.length - 1);
  const alpha = BASE_ALPHA / comparisons;

  const variants: VariantResult[] = rows.map((row, i) => ({
    ...row,
    isControl: i === 0,
    configuredWeight: flag.variants[i]!.weight,
    rate: row.exposures === 0 ? 0 : row.conversions / row.exposures,
    comparison: i === 0 ? null : compareProportions(control, row, alpha),
  }));

  const totalExposures = rows.reduce((s, r) => s + r.exposures, 0);
  const srm = sampleRatioMismatch(
    rows.map((r) => r.exposures),
    flag.variants.map((v) => v.weight)
  );

  const controlRate = control.exposures === 0 ? 0 : control.conversions / control.exposures;
  const required =
    control.exposures >= MIN_CONTROL_FOR_PLANNING
      ? requiredSampleSize(controlRate, flag.minDetectableEffect, alpha, POWER)
      : Number.POSITIVE_INFINITY;
  const requiredPerVariant = Number.isFinite(required) ? required : null;
  const smallestArm = Math.min(...rows.map((r) => r.exposures));
  const progress = requiredPerVariant ? Math.min(1, smallestArm / requiredPerVariant) : 0;

  const report = { flagKey: flag.key, metric: flag.primaryMetric, alpha, totalExposures, requiredPerVariant, progress, variants, srm };
  return { ...report, verdict: decide(flag, report) };
}

function decide(flag: FlagConfig, r: Omit<ExperimentReport, 'verdict'>): Verdict {
  if (r.totalExposures === 0) {
    return { kind: 'NOT_STARTED', headline: 'No one has been exposed to this experiment yet.', reasons: [] };
  }

  if (r.srm.mismatch) {
    const detail = r.variants
      .map((v, i) => `${v.variant} ${pct(r.srm.observedShares[i]!)} vs ${pct(r.srm.expectedShares[i]!)} expected`)
      .join(', ');
    return {
      kind: 'INVESTIGATE',
      headline: 'Sample ratio mismatch: the traffic split is broken, so these results cannot be trusted.',
      reasons: [
        `Observed split: ${detail} (chi-square p = ${r.srm.pValue.toExponential(1)}).`,
        'Common causes: a variant that crashes or redirects before logging, bot filtering applied to one arm, or changing weights mid-test.',
        'Fix the cause and restart the experiment with a new salt before reading any lift.',
      ],
    };
  }

  const reasons: string[] = [`Traffic split looks healthy (SRM p = ${r.srm.pValue.toFixed(2)}).`];
  if (flag.variants.length > 2) {
    reasons.push(`${flag.variants.length - 1} treatments vs one control, so each needs p < ${r.alpha.toFixed(3)} (Bonferroni-corrected).`);
  }

  const treatments = r.variants.filter((v) => !v.isControl && v.comparison);
  const winners = treatments.filter((v) => v.comparison!.significant && v.comparison!.absoluteLift > 0);
  const losers = treatments.filter((v) => v.comparison!.significant && v.comparison!.absoluteLift < 0);
  const powered = r.progress >= 1;
  const sampleNote = r.requiredPerVariant
    ? `${pct(r.progress, 0)} of the planned ${r.requiredPerVariant.toLocaleString('en-US')} users per variant`
    : 'not enough control traffic yet to plan a sample size';

  if (losers.length > 0 && winners.length === 0) {
    const worst = losers.reduce((a, b) => (a.comparison!.absoluteLift < b.comparison!.absoluteLift ? a : b));
    return {
      kind: 'DONT_SHIP',
      headline: `Don't ship: ${worst.variant} is significantly worse than control.`,
      reasons: [
        ...reasons,
        `${worst.variant} ${describeLift(worst.comparison!)} on ${r.metric}.`,
        'Harm is worth acting on before the planned sample is reached: roll it back to stop the damage.',
      ],
    };
  }

  if (winners.length > 0) {
    const best = winners.reduce((a, b) => ((a.comparison!.relativeLift ?? 0) > (b.comparison!.relativeLift ?? 0) ? a : b));
    if (powered) {
      return {
        kind: 'SHIP',
        winner: best.variant,
        headline: `Ship ${best.variant}.`,
        reasons: [...reasons, `${best.variant} ${describeLift(best.comparison!)} on ${r.metric}.`, `Reached ${sampleNote}.`],
      };
    }
    return {
      kind: 'KEEP_RUNNING',
      headline: `Promising, but keep running: ${best.variant} is ahead early.`,
      reasons: [
        ...reasons,
        `${best.variant} ${describeLift(best.comparison!)}, but the test is at ${sampleNote}.`,
        'Stopping the moment a result looks significant ("peeking") inflates the false-positive rate well beyond 5%.',
      ],
    };
  }

  if (powered) {
    return {
      kind: 'NO_DIFFERENCE',
      headline: 'No meaningful difference. Ship whichever option is cheaper to maintain.',
      reasons: [
        ...reasons,
        `Reached ${sampleNote} with no significant change in ${r.metric}.`,
        `Any real effect is likely smaller than the ${pct(flag.minDetectableEffect, 0)} lift this test was sized to detect.`,
      ],
    };
  }

  return {
    kind: 'KEEP_RUNNING',
    headline: 'Keep running: not enough data to call it yet.',
    reasons: [...reasons, `The test is at ${sampleNote}.`],
  };
}

function describeLift(c: Comparison): string {
  if (c.relativeLift === null || !c.relativeLiftInterval) {
    return `changed the conversion rate by ${pct(c.absoluteLift, 2)} points (${pText(c.pValue)})`;
  }
  const [low, high] = c.relativeLiftInterval;
  return `moved conversion ${signed(c.relativeLift)} (CI ${signed(low)} to ${signed(high)}, ${pText(c.pValue)})`;
}

function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${pct(x)}`;
}

function pText(p: number): string {
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}
