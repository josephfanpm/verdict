import type { AnalysisInput } from './aggregate.js';
import { metricLabel } from './flag.js';
import {
  armFromCounts,
  compareMeans,
  compareProportions,
  cuped,
  meanMoments,
  ratioMoments,
  requiredSampleSize,
  requiredSampleSizeMean,
  sampleRatioMismatch,
  type ArmStats,
  type Comparison,
  type SequentialOptions,
  type SrmResult,
} from './stats.js';
import type { FlagConfig, MetricDef, MetricKind, SamplePlan, VariantCounts } from './types.js';

export type VerdictKind = 'NOT_STARTED' | 'INVESTIGATE' | 'DONT_SHIP' | 'SHIP' | 'NO_DIFFERENCE' | 'KEEP_RUNNING';

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  reasons: string[];
  winner?: string;
}

/** Where a treatment landed on a metric, taking the metric's good direction into account. */
export type Outcome = 'better' | 'worse' | 'flat';

export interface VariantResult extends VariantCounts {
  isControl: boolean;
  configuredWeight: number;
  /** Users included in the goal metric (exposed once, conversion window closed). */
  analyzed: number;
  /** The goal metric's value: a conversion rate, a per-user average, or a ratio. */
  rate: number;
  /** Comparison against control; null for the control itself or when there is no data. */
  comparison: Comparison | null;
  outcome: Outcome | null;
}

export interface MetricVariantResult {
  variant: string;
  isControl: boolean;
  analyzed: number;
  value: number;
  comparison: Comparison | null;
  outcome: Outcome | null;
}

export interface MetricReport {
  metric: MetricDef;
  label: string;
  variants: MetricVariantResult[];
  /** Share of noise removed using pre-experiment behavior, or 0 when CUPED was not applied. */
  varianceReduction: number;
}

export interface SegmentResult {
  value: string;
  exposures: number;
  srm: SrmResult;
  variants: MetricVariantResult[];
}

export interface HealthReport {
  multipleExposures: { count: number; share: number; flagged: boolean };
  /** Split check per day, to show when a split broke. */
  srmByDay: Array<{ day: number; exposures: number[]; pValue: number; mismatch: boolean }>;
  /** An A/A test on behavior before exposure. A difference here cannot be caused by the treatment. */
  preExperiment: { checked: boolean; flagged: boolean; variants: Array<{ variant: string; value: number; pValue: number | null }> };
  /** Users waiting for their conversion window to close. */
  inProgress: number;
}

export interface ExperimentReport {
  flagKey: string;
  metric: string;
  metricKind: MetricKind;
  /** Significance threshold per comparison, after Bonferroni correction. */
  alpha: number;
  sequential: boolean;
  totalExposures: number;
  /** Users needed in each variant to reach the planned power, or null if unknown yet. */
  requiredPerVariant: number | null;
  /** 'locked' plans never move. A 'provisional' plan is an estimate until enough control data exists to lock it. */
  planSource: 'locked' | 'provisional' | null;
  /** 0..1, how far the smallest variant is toward requiredPerVariant. */
  progress: number;
  /** Days between the first and latest exposure, or null if unknown. */
  runtimeDays: number | null;
  minRuntimeDays: number;
  variants: VariantResult[];
  /** Share of goal-metric noise removed by CUPED (0 when not applied). */
  varianceReduction: number;
  guardrails: MetricReport[];
  srm: SrmResult;
  health: HealthReport;
  segments: Record<string, SegmentResult[]>;
  verdict: Verdict;
}

const BASE_ALPHA = 0.05;
const POWER = 0.8;
/** Below this, the control's observed value is too noisy to even estimate a sample size from. */
export const MIN_CONTROL_FOR_PLANNING = 100;
/** Once control reaches this many users, the plan is locked and never recomputed. */
export const MIN_CONTROL_FOR_LOCK = 1_000;
/** Trust-check thresholds are strict because the checks run constantly and must rarely cry wolf. */
const TRUST_THRESHOLD = 0.001;
const MULTIPLE_EXPOSURE_LIMIT = 0.01;
/** CUPED is only applied when it removes at least this share of the variance. */
const MIN_VARIANCE_REDUCTION = 0.01;
const DEFAULT_SEQUENTIAL_TUNING = 10_000;

/** Compare one treatment arm to control on a metric, without variance reduction. */
export function compareStats(kind: MetricKind, control: ArmStats, treatment: ArmStats, alpha: number, sequential?: SequentialOptions): Comparison | null {
  if (kind === 'conversion') {
    return compareProportions({ exposures: control.n, conversions: control.converters }, { exposures: treatment.n, conversions: treatment.converters }, alpha, sequential);
  }
  const moments = kind === 'ratio' ? ratioMoments : meanMoments;
  return compareMeans(moments(control), moments(treatment), alpha, sequential);
}

function outcomeOf(metric: MetricDef, c: Comparison | null): Outcome | null {
  if (!c) return null;
  if (!c.significant || c.absoluteLift === 0) return 'flat';
  return c.absoluteLift > 0 === (metric.direction === 'increase') ? 'better' : 'worse';
}

function valueOf(kind: MetricKind, arm: ArmStats): number {
  return kind === 'ratio' ? ratioMoments(arm).mean : meanMoments(arm).mean;
}

/** Every arm of one metric against control (arms[0]). */
function compareMetric(
  flag: FlagConfig,
  metric: MetricDef,
  arms: ArmStats[],
  alpha: number,
  sequential: SequentialOptions | undefined
): { variants: MetricVariantResult[]; varianceReduction: number } {
  // CUPED needs a per-user pre-experiment value, which ratio metrics do not have.
  const adjusted = flag.cuped && metric.kind !== 'ratio' ? cuped(arms) : null;
  const useCuped = adjusted !== null && adjusted.varianceReduction >= MIN_VARIANCE_REDUCTION;

  const variants = flag.variants.map((v, i) => {
    const arm = arms[i]!;
    let comparison: Comparison | null = null;
    if (i > 0) {
      comparison = useCuped
        ? compareMeans(adjusted.adjusted[0]!, adjusted.adjusted[i]!, alpha, sequential)
        : compareStats(metric.kind, arms[0]!, arm, alpha, sequential);
    }
    return { variant: v.key, isControl: i === 0, analyzed: arm.n, value: valueOf(metric.kind, arm), comparison, outcome: outcomeOf(metric, comparison) };
  });
  return { variants, varianceReduction: useCuped ? adjusted.varianceReduction : 0 };
}

/** The sample size per variant implied by a baseline, or Infinity when it cannot be planned. */
function sampleSizeFor(flag: FlagConfig, baseline: number, baselineSd: number | null, alpha: number): number {
  if (flag.goal.kind === 'conversion') return requiredSampleSize(baseline, flag.minDetectableEffect, alpha, POWER);
  return baselineSd === null ? Number.POSITIVE_INFINITY : requiredSampleSizeMean(baseline, baselineSd, flag.minDetectableEffect, alpha, POWER);
}

function alphaFor(flag: FlagConfig): number {
  // Comparing several treatments to one control multiplies the chances of a
  // fluke "win", so the per-comparison threshold is divided (Bonferroni).
  return BASE_ALPHA / Math.max(1, flag.variants.length - 1);
}

function observedBaseline(flag: FlagConfig, control: ArmStats): { baseline: number; baselineSd: number } {
  const m = flag.goal.kind === 'ratio' ? ratioMoments(control) : meanMoments(control);
  return { baseline: m.mean, baselineSd: Math.sqrt(m.variance) };
}

/**
 * The plan to lock in, if the flag does not have one yet and one can be made:
 * from the stated baseline if there is one, otherwise from the control arm
 * once it is large enough to be a stable estimate. Returns null if there is
 * nothing to lock. The server stores the result so the target never moves again.
 */
export function planToLock(flag: FlagConfig, control: ArmStats | null, now: number): SamplePlan | null {
  if (flag.plan.requiredPerVariant !== null) return null;
  const alpha = alphaFor(flag);

  if (flag.plan.baseline !== null) {
    const required = sampleSizeFor(flag, flag.plan.baseline, flag.plan.baselineSd, alpha);
    if (Number.isFinite(required)) return { ...flag.plan, requiredPerVariant: required, source: 'stated', lockedAt: now };
  }
  if (control && control.n >= MIN_CONTROL_FOR_LOCK) {
    const { baseline, baselineSd } = observedBaseline(flag, control);
    const required = sampleSizeFor(flag, baseline, baselineSd, alpha);
    if (Number.isFinite(required)) return { baseline, baselineSd, requiredPerVariant: required, source: 'observed', lockedAt: now };
  }
  return null;
}

function isCounts(input: VariantCounts[] | AnalysisInput): input is VariantCounts[] {
  return Array.isArray(input);
}

/** Turn plain exposure and conversion counts into the engine's input. */
export function inputFromCounts(flag: FlagConfig, counts: VariantCounts[]): AnalysisInput {
  const byKey = new Map(counts.map((c) => [c.variant, c]));
  const rows = flag.variants.map((v) => byKey.get(v.key) ?? { variant: v.key, exposures: 0, conversions: 0 });
  return {
    exposures: rows.map((r) => r.exposures),
    goal: rows.map((r) => armFromCounts(r.exposures, r.conversions)),
    guardrails: flag.guardrails.map(() => rows.map(() => armFromCounts(0, 0))),
  };
}

/** Turn an experiment's data into a decision a PM can act on. */
export function analyze(flag: FlagConfig, data: VariantCounts[] | AnalysisInput): ExperimentReport {
  const input = isCounts(data) ? inputFromCounts(flag, data) : data;
  const alpha = alphaFor(flag);
  const control = input.goal[0]!;

  // --- sample plan -----------------------------------------------------------
  let required: number = Number.POSITIVE_INFINITY;
  let planSource: ExperimentReport['planSource'] = null;
  if (flag.plan.requiredPerVariant !== null) {
    required = flag.plan.requiredPerVariant;
    planSource = 'locked';
  } else if (flag.plan.baseline !== null) {
    required = sampleSizeFor(flag, flag.plan.baseline, flag.plan.baselineSd, alpha);
    planSource = Number.isFinite(required) ? 'locked' : null;
  }
  if (!Number.isFinite(required) && control.n >= MIN_CONTROL_FOR_PLANNING) {
    const { baseline, baselineSd } = observedBaseline(flag, control);
    required = sampleSizeFor(flag, baseline, baselineSd, alpha);
    planSource = Number.isFinite(required) ? 'provisional' : null;
  }
  const requiredPerVariant = Number.isFinite(required) ? required : null;
  const smallestArm = Math.min(...input.goal.map((a) => a.n));
  const progress = requiredPerVariant ? Math.min(1, smallestArm / requiredPerVariant) : 0;

  const sequential: SequentialOptions | undefined = flag.sequential
    ? { tuning: requiredPerVariant ? requiredPerVariant * 2 : DEFAULT_SEQUENTIAL_TUNING }
    : undefined;

  // --- metrics ---------------------------------------------------------------
  const goal = compareMetric(flag, flag.goal, input.goal, alpha, sequential);
  const variants: VariantResult[] = flag.variants.map((v, i) => {
    const g = goal.variants[i]!;
    return {
      variant: v.key,
      exposures: input.exposures[i] ?? 0,
      conversions: input.goal[i]!.converters,
      isControl: i === 0,
      configuredWeight: v.weight,
      analyzed: g.analyzed,
      rate: g.value,
      comparison: g.comparison,
      outcome: g.outcome,
    };
  });
  const guardrails: MetricReport[] = flag.guardrails.map((metric, i) => {
    const arms = input.guardrails[i] ?? flag.variants.map(() => armFromCounts(0, 0));
    return { metric, label: metricLabel(metric), ...compareMetric(flag, metric, arms, alpha, sequential) };
  });

  // --- trust checks ----------------------------------------------------------
  const weights = flag.variants.map((v) => v.weight);
  const totalExposures = input.exposures.reduce((s, n) => s + n, 0);
  const srm = sampleRatioMismatch(input.exposures, weights);

  const multiCount = input.multipleExposures ?? 0;
  const analyzedUsers = input.goal.reduce((s, a) => s + a.n, 0) + (input.inProgress ?? 0);
  const multiShare = multiCount + analyzedUsers === 0 ? 0 : multiCount / (multiCount + analyzedUsers);

  const preChecked = input.goal.some((a) => a.xSumSq > 0) && input.goal.every((a) => a.n >= 2);
  const preArms = input.goal.map((a) => ({ n: a.n, mean: a.n === 0 ? 0 : a.xSum / a.n, variance: a.n < 2 ? 0 : Math.max(0, (a.xSumSq - (a.xSum * a.xSum) / a.n) / (a.n - 1)) }));
  const preVariants = flag.variants.map((v, i) => ({
    variant: v.key,
    value: preArms[i]!.mean,
    pValue: i === 0 || !preChecked ? null : (compareMeans(preArms[0]!, preArms[i]!, TRUST_THRESHOLD)?.pValue ?? null),
  }));

  const health: HealthReport = {
    multipleExposures: { count: multiCount, share: multiShare, flagged: multiCount >= 10 && multiShare > MULTIPLE_EXPOSURE_LIMIT },
    srmByDay: (input.daily ?? []).map((d) => {
      const check = sampleRatioMismatch(d.exposures, weights);
      return { day: d.day, exposures: d.exposures, pValue: check.pValue, mismatch: check.mismatch };
    }),
    preExperiment: { checked: preChecked, flagged: preVariants.some((v) => v.pValue !== null && v.pValue < TRUST_THRESHOLD), variants: preVariants },
    inProgress: input.inProgress ?? 0,
  };

  // --- segments (exploratory: they explain a result, they do not decide it) ---
  const segments: Record<string, SegmentResult[]> = {};
  for (const [dimension, values] of Object.entries(input.segments ?? {})) {
    segments[dimension] = values.map((s) => ({
      value: s.value,
      exposures: s.exposures.reduce((a, b) => a + b, 0),
      srm: sampleRatioMismatch(s.exposures, weights),
      variants: compareMetric(flag, flag.goal, s.goal, alpha, sequential).variants,
    }));
  }

  const report = {
    flagKey: flag.key,
    metric: metricLabel(flag.goal),
    metricKind: flag.goal.kind,
    alpha,
    sequential: flag.sequential,
    totalExposures,
    requiredPerVariant,
    planSource,
    progress,
    runtimeDays: input.runtimeDays ?? null,
    minRuntimeDays: flag.minRuntimeDays,
    variants,
    varianceReduction: goal.varianceReduction,
    guardrails,
    srm,
    health,
    segments,
  };
  return { ...report, verdict: decide(flag, report) };
}

/**
 * The decision. Checks run in this order, and the order is the product:
 * trust first, then harm, then wins, then "nothing here".
 */
function decide(flag: FlagConfig, r: Omit<ExperimentReport, 'verdict'>): Verdict {
  if (r.totalExposures === 0) {
    return { kind: 'NOT_STARTED', headline: 'No one has been exposed to this experiment yet.', reasons: [] };
  }

  // 1. Trust. If the data is broken, no lift number means anything.
  if (r.srm.mismatch) {
    const detail = r.variants.map((v, i) => `${v.variant} ${pct(r.srm.observedShares[i]!)} vs ${pct(r.srm.expectedShares[i]!)} expected`).join(', ');
    const badDays = r.health.srmByDay.filter((d) => d.mismatch);
    const worstSegment = Object.entries(r.segments)
      .flatMap(([dimension, values]) => values.map((s) => ({ dimension, ...s })))
      .filter((s) => s.srm.mismatch)
      .sort((a, b) => a.srm.pValue - b.srm.pValue)[0];
    return {
      kind: 'INVESTIGATE',
      headline: 'Sample ratio mismatch: the traffic split is broken, so these results cannot be trusted.',
      reasons: [
        `Observed split: ${detail} (chi-square p = ${r.srm.pValue.toExponential(1)}).`,
        ...(worstSegment ? [`Start with ${worstSegment.dimension} = ${worstSegment.value}: the split is furthest off there.`] : []),
        // Only worth saying when the break is confined to some days: that points at a deploy, not at the design.
        ...(badDays.length >= 2 && badDays.length <= r.health.srmByDay.length / 2
          ? [`The split is off on ${badDays.length} of ${r.health.srmByDay.length} days, first on ${new Date(badDays[0]!.day).toISOString().slice(0, 10)}. Look at what shipped then.`]
          : []),
        'Common causes: a variant that crashes or redirects before logging, bot filtering applied to one arm, or changing weights mid-test.',
        'Fix the cause and restart the experiment before reading any lift.',
      ],
    };
  }
  if (r.health.multipleExposures.flagged) {
    const m = r.health.multipleExposures;
    return {
      kind: 'INVESTIGATE',
      headline: 'Too many users saw more than one variant, so these results cannot be trusted.',
      reasons: [
        `${m.count.toLocaleString('en-US')} users (${pct(m.share)}) were logged in two variants. They are left out of the numbers, but that many means assignment is unstable.`,
        'Common causes: the user id changing at login without an anonymous id to bucket on, or two code paths evaluating the flag with different ids.',
        'Fix the cause and restart the experiment before reading any lift.',
      ],
    };
  }
  if (r.health.preExperiment.flagged) {
    return {
      kind: 'INVESTIGATE',
      headline: 'The groups were already different before the experiment started.',
      reasons: [
        `${r.metric} differs between variants in the ${flag.preExperimentDays} days before exposure, which the treatment cannot have caused.`,
        'Common causes: assignment that depends on past behavior, or exposures logged only for users who reach a later screen.',
        'Fix the cause and restart the experiment before reading any lift.',
      ],
    };
  }

  const reasons: string[] = [`Traffic split looks healthy (SRM p = ${r.srm.pValue.toFixed(2)}).`];
  if (flag.variants.length > 2) {
    reasons.push(`${flag.variants.length - 1} treatments vs one control, so each needs p < ${r.alpha.toFixed(3)} (Bonferroni-corrected).`);
  }
  if (r.health.multipleExposures.count > 0) {
    reasons.push(`${r.health.multipleExposures.count.toLocaleString('en-US')} users seen in two variants were left out.`);
  }

  // 2. What each treatment did to the goal and to the guardrails.
  const treatments = r.variants
    .filter((v) => !v.isControl && v.comparison)
    .map((v) => ({
      variant: v.variant,
      comparison: v.comparison!,
      outcome: v.outcome,
      broken: r.guardrails.flatMap((g) => {
        const row = g.variants.find((x) => x.variant === v.variant);
        return row?.outcome === 'worse' ? [{ label: g.label, comparison: row.comparison! }] : [];
      }),
    }));
  const harmful = treatments.filter((t) => t.outcome === 'worse' || t.broken.length > 0);
  const winners = treatments.filter((t) => t.outcome === 'better');
  const cleanWinners = winners.filter((t) => t.broken.length === 0);
  const undecided = treatments.filter((t) => !harmful.includes(t) && !winners.includes(t));

  const sampleDone = r.progress >= 1;
  const runtimeDone = r.runtimeDays === null || r.runtimeDays >= r.minRuntimeDays;
  const sampleNote = r.requiredPerVariant
    ? `${pct(r.progress, 0)} of the planned ${r.requiredPerVariant.toLocaleString('en-US')} users per variant`
    : 'not enough control traffic yet to plan a sample size';
  const runtimeNote =
    r.runtimeDays === null ? null : `Users have been enrolled across ${formatDays(r.runtimeDays)} of the minimum ${r.minRuntimeDays} days.`;
  const describeHarm = (t: (typeof treatments)[number]) =>
    t.outcome === 'worse'
      ? `${t.variant} ${describeLift(t.comparison, r.metric)}.`
      : `${t.variant} ${describeLift(t.broken[0]!.comparison, `the guardrail ${t.broken[0]!.label}`)}.`;
  const earlyHarmNote = r.sequential
    ? 'The sequential test stays valid however often it is read, so harm can be acted on now.'
    : 'Harm is worth acting on before the planned sample is reached: roll it back to stop the damage.';

  // 3. A winner that keeps every guardrail intact.
  if (cleanWinners.length > 0) {
    const sign = flag.goal.direction === 'increase' ? 1 : -1;
    const best = cleanWinners.reduce((a, b) => (sign * (a.comparison.relativeLift ?? a.comparison.absoluteLift) > sign * (b.comparison.relativeLift ?? b.comparison.absoluteLift) ? a : b));
    const lift = `${best.variant} ${describeLift(best.comparison, r.metric)}.`;
    const dropNotes = harmful.filter((t) => t !== best).map((t) => `Drop ${t.variant}: ${describeHarm(t)}`);
    const ready = runtimeDone && (r.sequential || sampleDone);

    if (ready) {
      const losers = harmful.filter((t) => t !== best).map((t) => t.variant);
      return {
        kind: 'SHIP',
        winner: best.variant,
        headline: losers.length > 0 ? `Ship ${best.variant}, and drop ${losers.join(' and ')}.` : `Ship ${best.variant}.`,
        reasons: [
          ...reasons,
          lift,
          sampleDone ? `Reached ${sampleNote}.` : `Called at ${sampleNote}: the sequential test is valid at any sample size.`,
          ...(r.runtimeDays !== null ? [`Users were enrolled across ${formatDays(r.runtimeDays)} days (minimum ${r.minRuntimeDays}).`] : []),
          ...(r.guardrails.length > 0 ? [`Guardrails held: ${r.guardrails.map((g) => g.label).join(', ')}.`] : []),
          ...dropNotes,
        ],
      };
    }
    return {
      kind: 'KEEP_RUNNING',
      headline: `Promising, but keep running: ${best.variant} is ahead early.`,
      reasons: [
        ...reasons,
        lift,
        ...(!r.sequential && !sampleDone
          ? [`The test is at ${sampleNote}.`, 'Stopping the moment a result looks significant ("peeking") inflates the false-positive rate well beyond 5%.']
          : []),
        ...(!runtimeDone && runtimeNote ? [runtimeNote, 'A full cycle covers weekday and weekend behavior, so an early win is not just one kind of day.'] : []),
        ...dropNotes,
      ],
    };
  }

  // 4. Harm: a worse goal, or a broken guardrail with no clean alternative.
  if (harmful.length > 0) {
    const worst = harmful.reduce((a, b) => (a.comparison.pValue <= b.comparison.pValue ? a : b));
    const viaGuardrail = worst.outcome !== 'worse';
    return {
      kind: 'DONT_SHIP',
      headline: viaGuardrail
        ? `Don't ship: ${worst.variant} breaks the guardrail ${worst.broken[0]!.label}.`
        : `Don't ship: ${worst.variant} is significantly worse than control.`,
      reasons: [
        ...reasons,
        ...(viaGuardrail && worst.outcome === 'better' ? [`${worst.variant} ${describeLift(worst.comparison, r.metric)}, which looks like a win on its own.`] : []),
        ...harmful.map(describeHarm),
        earlyHarmNote,
        ...(undecided.length > 0 ? [`Still undecided: ${undecided.map((t) => t.variant).join(', ')}. It can keep running without ${harmful.map((t) => t.variant).join(' or ')}.`] : []),
      ],
    };
  }

  // 5. Nothing found, and the test was big enough and long enough to find it.
  if (sampleDone && runtimeDone) {
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
    reasons: [
      ...reasons,
      `The test is at ${sampleNote}.`,
      ...(!runtimeDone && runtimeNote ? [runtimeNote] : []),
      ...(r.health.inProgress > 0 ? [`${r.health.inProgress.toLocaleString('en-US')} users are still inside their conversion window and are not counted yet.`] : []),
    ],
  };
}

function describeLift(c: Comparison, metric: string): string {
  if (c.relativeLift === null || !c.relativeLiftInterval) {
    return `changed ${metric} by ${c.absoluteLift.toPrecision(3)} (${pText(c.pValue)})`;
  }
  const [low, high] = c.relativeLiftInterval;
  return `moved ${metric} ${signed(c.relativeLift)} (CI ${signed(low)} to ${signed(high)}, ${pText(c.pValue)})`;
}

function formatDays(days: number): string {
  return days >= 10 ? Math.round(days).toString() : (Math.floor(days * 10) / 10).toString();
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
