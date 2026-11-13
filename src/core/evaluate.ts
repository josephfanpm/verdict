import { BUCKET_COUNT, bucketFor } from './hash.js';
import type { Condition, EvaluableFlag, Evaluation, EvaluationReason, FlagConfig, MetricDef, UserContext } from './types.js';

/**
 * Decide which variant a user sees. Checks run in a fixed order, and every
 * early exit serves a variant without counting the user in the experiment:
 *
 *  1. overrides    forced variants for named users (QA, staff), even before launch
 *  2. rolled out   everyone gets the shipped variant
 *  3. off          default variant
 *  4. targeting    default variant for users the experiment is not aimed at
 *  5. holdout      default variant for the group kept back from every new feature
 *  6. exclusion    default variant for users reserved for another test in the group
 *  7. rollout      default variant for users outside the rollout percentage
 *  8. assignment   the experiment picks the variant, and the user is counted
 *
 * Rollout and assignment use two independent hashes on purpose: raising
 * rolloutPercent from 10% to 50% only *adds* users. Everyone already in the
 * experiment keeps their variant, which keeps a ramp-up from contaminating results.
 */
export function evaluate(flag: EvaluableFlag, user: UserContext): Evaluation {
  // Bucket on the id that existed first, so logging in does not move a user between variants.
  const unitId = user.anonymousId ?? user.id;
  const serve = (variant: string, reason: EvaluationReason, extra: Partial<Evaluation> = {}): Evaluation => {
    const value = flag.variants.find((v) => v.key === variant)?.value;
    return {
      flagKey: flag.key,
      variant,
      ...(value !== undefined ? { value } : {}),
      reason,
      inExperiment: false,
      bucket: null,
      unitId,
      phase: flag.phase,
      version: flag.version,
      ...extra,
    };
  };

  if (flag.status === 'archived') return serve(flag.defaultVariant, 'FLAG_DISABLED');

  for (const rule of flag.overrides) {
    if (rule.conditions.length > 0 && rule.conditions.every((c) => matches(c, user))) return serve(rule.variant, 'OVERRIDE');
  }

  if (flag.status === 'rolled_out' && flag.rolledOutVariant) return serve(flag.rolledOutVariant, 'ROLLED_OUT');
  if (!flag.enabled) return serve(flag.defaultVariant, 'FLAG_DISABLED');

  if (!flag.targeting.every((condition) => matches(condition, user))) return serve(flag.defaultVariant, 'TARGETING_MISS');

  let holdout: Evaluation['holdout'];
  if (flag.holdout) {
    // The hash depends only on the holdout key, so every flag behind it holds back the same users.
    const held = bucketFor(`holdout:${flag.holdout.key}:${unitId}`) < percentToBuckets(flag.holdout.percent);
    holdout = { key: flag.holdout.key, held };
    if (held) return serve(flag.defaultVariant, 'HOLDOUT', { holdout });
  }
  const extra = holdout ? { holdout } : {};

  if (flag.exclusion) {
    // Flags in one group share this hash and own non-overlapping slices of it.
    const slot = bucketFor(`exclusion:${flag.exclusion.group}:${unitId}`);
    if (slot < percentToBuckets(flag.exclusion.start) || slot >= percentToBuckets(flag.exclusion.end)) {
      return serve(flag.defaultVariant, 'EXCLUDED', extra);
    }
  }

  const rolloutBucket = bucketFor(`${flag.salt}:rollout:${unitId}`);
  if (rolloutBucket >= percentToBuckets(flag.rolloutPercent)) return serve(flag.defaultVariant, 'OUTSIDE_ROLLOUT', extra);

  const bucket = bucketFor(`${flag.salt}:variant:${unitId}`);
  // Round the cumulative boundary, not each weight, so weights like
  // 33.3/33.3/33.3 still cover every bucket instead of leaving a gap at the end.
  let cumulativeWeight = 0;
  for (const variant of flag.variants) {
    cumulativeWeight += variant.weight;
    if (bucket < percentToBuckets(cumulativeWeight)) {
      return serve(variant.key, 'ASSIGNED', { ...extra, inExperiment: true, bucket });
    }
  }

  // Only reachable if weights do not sum to 100, which validateFlag rejects.
  throw new Error(`Flag "${flag.key}" has variant weights that do not cover all buckets`);
}

function percentToBuckets(percent: number): number {
  return Math.round((percent / 100) * BUCKET_COUNT);
}

function matches(condition: Condition, user: UserContext): boolean {
  const raw = condition.attribute === 'id' ? user.id : user.attributes?.[condition.attribute];
  if (raw === undefined) return condition.operator === 'not_equals' || condition.operator === 'not_in';

  const value = String(raw);
  const values = condition.values.map(String);

  switch (condition.operator) {
    case 'equals':
      return value === values[0];
    case 'not_equals':
      return value !== values[0];
    case 'in':
      return values.includes(value);
    case 'not_in':
      return !values.includes(value);
    case 'contains':
      return values.some((v) => value.includes(v));
    case 'gt':
      return Number(raw) > Number(condition.values[0]);
    case 'lt':
      return Number(raw) < Number(condition.values[0]);
  }
}

/** The dimension attributes to store with an exposure, as strings. */
export function exposureAttributes(flag: Pick<FlagConfig, 'dimensions'>, user: UserContext): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  for (const name of flag.dimensions) {
    const raw = user.attributes?.[name];
    if (raw !== undefined) picked[name] = String(raw);
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-_]{1,62}$/;

function validateMetric(m: MetricDef, label: string): string[] {
  const errors: string[] = [];
  if (!m.event) errors.push(`${label} needs an event name.`);
  if (m.kind === 'ratio' && !m.denominatorEvent) errors.push(`${label} is a ratio, so it needs a denominator event.`);
  if (m.windowHours !== null && !(m.windowHours > 0)) errors.push(`${label} conversion window must be a positive number of hours.`);
  if (m.capPercentile !== null && !(m.capPercentile > 0.5 && m.capPercentile <= 1)) {
    errors.push(`${label} cap must be a percentile between 0.5 and 1, e.g. 0.99.`);
  }
  return errors;
}

/**
 * Semantic validation shared by the API and the dashboard form, so a user sees
 * the same error message whether they hit the API directly or use the UI.
 */
export function validateFlag(flag: FlagConfig): string[] {
  const errors: string[] = [];

  if (!FLAG_KEY_PATTERN.test(flag.key)) {
    errors.push('Key must be 2-63 lowercase letters, numbers, dashes or underscores.');
  }
  if (flag.variants.length < 2) {
    errors.push('An experiment needs at least two variants (a control and a treatment).');
  }

  const keys = flag.variants.map((v) => v.key);
  if (new Set(keys).size !== keys.length) {
    errors.push('Variant keys must be unique.');
  }
  if (flag.variants.some((v) => v.weight < 0)) {
    errors.push('Variant weights cannot be negative.');
  }

  const totalWeight = flag.variants.reduce((sum, v) => sum + v.weight, 0);
  if (Math.abs(totalWeight - 100) > 1e-9) {
    errors.push(`Variant weights must sum to 100 (currently ${totalWeight}).`);
  }
  if (!keys.includes(flag.defaultVariant)) {
    errors.push(`Default variant "${flag.defaultVariant}" is not one of the variants.`);
  }
  if (flag.rolledOutVariant !== null && !keys.includes(flag.rolledOutVariant)) {
    errors.push(`Rolled-out variant "${flag.rolledOutVariant}" is not one of the variants.`);
  }
  if (flag.rolloutPercent < 0 || flag.rolloutPercent > 100) {
    errors.push('Rollout percent must be between 0 and 100.');
  }
  if (!(flag.minDetectableEffect > 0 && flag.minDetectableEffect < 10)) {
    errors.push('Minimum detectable effect must be a positive relative lift, e.g. 0.05 for 5%.');
  }
  if (!(flag.minRuntimeDays >= 0 && flag.minRuntimeDays <= 90)) {
    errors.push('Minimum runtime must be between 0 and 90 days.');
  }
  if (!(flag.preExperimentDays >= 1 && flag.preExperimentDays <= 90)) {
    errors.push('Pre-experiment window must be between 1 and 90 days.');
  }

  errors.push(...validateMetric(flag.goal, 'Goal metric'));
  flag.guardrails.forEach((g, i) => errors.push(...validateMetric(g, `Guardrail ${i + 1}`)));

  flag.overrides.forEach((rule, i) => {
    if (!keys.includes(rule.variant)) errors.push(`Override ${i + 1} serves "${rule.variant}", which is not one of the variants.`);
    if (rule.conditions.length === 0) errors.push(`Override ${i + 1} needs at least one condition.`);
  });

  if (flag.exclusion) {
    const { group, start, end } = flag.exclusion;
    if (!group) errors.push('Exclusion group needs a name.');
    if (!(start >= 0 && end <= 100 && start < end)) errors.push('Exclusion range must satisfy 0 <= start < end <= 100.');
  }
  if (flag.holdout && !(flag.holdout.percent > 0 && flag.holdout.percent < 100)) {
    errors.push('Holdout percent must be between 0 and 100.');
  }
  if (flag.dimensions.length > 5) {
    errors.push('At most 5 dimensions can be recorded per experiment.');
  }
  if (flag.plan.baseline !== null && !(flag.plan.baseline > 0)) {
    errors.push('Expected baseline must be positive.');
  }
  if (flag.goal.kind === 'conversion' && flag.plan.baseline !== null && flag.plan.baseline >= 1) {
    errors.push('Expected baseline for a conversion goal is a rate between 0 and 1.');
  }

  return errors;
}
