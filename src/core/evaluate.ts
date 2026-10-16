import { BUCKET_COUNT, bucketFor } from './hash.js';
import type { Condition, Evaluation, FlagConfig, UserContext } from './types.js';

/**
 * Decide which variant a user sees.
 *
 * Two independent hashes are used on purpose:
 *  - the "rollout" hash decides whether the user is in the experiment at all
 *  - the "variant" hash decides which arm they get
 *
 * Because they are independent, raising rolloutPercent from 10% to 50% only
 * *adds* users. Everyone already in the experiment keeps their variant, which
 * is what keeps a ramp-up from contaminating results.
 */
export function evaluate(flag: FlagConfig, user: UserContext): Evaluation {
  const base = { flagKey: flag.key, version: flag.version };

  if (!flag.enabled) {
    return { ...base, variant: flag.defaultVariant, reason: 'FLAG_DISABLED', inExperiment: false, bucket: null };
  }

  if (!flag.targeting.every((condition) => matches(condition, user))) {
    return { ...base, variant: flag.defaultVariant, reason: 'TARGETING_MISS', inExperiment: false, bucket: null };
  }

  const rolloutBucket = bucketFor(`${flag.salt}:rollout:${user.id}`);
  if (rolloutBucket >= percentToBuckets(flag.rolloutPercent)) {
    return { ...base, variant: flag.defaultVariant, reason: 'OUTSIDE_ROLLOUT', inExperiment: false, bucket: null };
  }

  const bucket = bucketFor(`${flag.salt}:variant:${user.id}`);
  // Round the cumulative boundary, not each weight, so weights like
  // 33.3/33.3/33.3 still cover every bucket instead of leaving a gap at the end.
  let cumulativeWeight = 0;
  for (const variant of flag.variants) {
    cumulativeWeight += variant.weight;
    if (bucket < percentToBuckets(cumulativeWeight)) {
      return { ...base, variant: variant.key, reason: 'ASSIGNED', inExperiment: true, bucket };
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

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-_]{1,62}$/;

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
  if (flag.rolloutPercent < 0 || flag.rolloutPercent > 100) {
    errors.push('Rollout percent must be between 0 and 100.');
  }
  if (!(flag.minDetectableEffect > 0 && flag.minDetectableEffect < 10)) {
    errors.push('Minimum detectable effect must be a positive relative lift, e.g. 0.05 for 5%.');
  }

  return errors;
}
