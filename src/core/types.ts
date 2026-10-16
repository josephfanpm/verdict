/**
 * Shared domain types. Everything in src/core is pure TypeScript with no I/O,
 * so the server, the SDK, and the dashboard all run the exact same logic.
 */

export type Operator = 'equals' | 'not_equals' | 'in' | 'not_in' | 'contains' | 'gt' | 'lt';

/** A targeting condition. All conditions on a flag must match (logical AND). */
export interface Condition {
  attribute: string;
  operator: Operator;
  values: Array<string | number>;
}

/** A variant and its share of experiment traffic. Weights across a flag sum to 100. */
export interface Variant {
  key: string;
  weight: number;
}

export interface FlagConfig {
  key: string;
  description: string;
  enabled: boolean;
  /** Mixed into every hash so two flags never bucket users identically. */
  salt: string;
  /** Percent (0-100) of eligible users who enter the experiment at all. */
  rolloutPercent: number;
  /** The first variant is treated as the control. */
  variants: Variant[];
  /** Served when the flag is off, targeting misses, or the user is outside the rollout. */
  defaultVariant: string;
  targeting: Condition[];
  /** Event name that counts as a conversion for this experiment. */
  primaryMetric: string;
  /** Smallest relative lift worth detecting (0.1 = 10%). Drives the required sample size. */
  minDetectableEffect: number;
  /** Incremented on every change, recorded alongside each exposure. */
  version: number;
}

export type Attributes = Record<string, string | number | boolean>;

export interface UserContext {
  id: string;
  attributes?: Attributes;
}

export type EvaluationReason = 'FLAG_DISABLED' | 'TARGETING_MISS' | 'OUTSIDE_ROLLOUT' | 'ASSIGNED';

export interface Evaluation {
  flagKey: string;
  variant: string;
  reason: EvaluationReason;
  /** True only when the user was assigned by the experiment and should be counted. */
  inExperiment: boolean;
  /** Variant bucket in [0, 10000), or null if the user never reached bucketing. */
  bucket: number | null;
  version: number;
}

/** Raw counts for one variant: how many users saw it and how many converted. */
export interface VariantCounts {
  variant: string;
  exposures: number;
  conversions: number;
}
