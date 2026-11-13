/**
 * Shared domain types. Everything in src/core is pure TypeScript with no I/O,
 * so the server, the SDK, and the dashboard all run the exact same logic.
 */

export type Operator = 'equals' | 'not_equals' | 'in' | 'not_in' | 'contains' | 'gt' | 'lt';

/** A targeting condition. All conditions in a list must match (logical AND). */
export interface Condition {
  attribute: string;
  operator: Operator;
  values: Array<string | number>;
}

export type VariantValue = string | number | boolean | Record<string, unknown>;

/** A variant and its share of experiment traffic. Weights across a flag sum to 100. */
export interface Variant {
  key: string;
  weight: number;
  /** Optional payload the application reads instead of branching on the key. */
  value?: VariantValue;
}

/**
 * How a metric turns a user's events into one number.
 *  - conversion: 1 if the user fired the event at least once, else 0
 *  - mean:       the sum of the event's `value` for the user (or the event count when no value is sent)
 *  - ratio:      sum of the event's value divided by the count of `denominatorEvent`, across users
 */
export type MetricKind = 'conversion' | 'mean' | 'ratio';

export interface MetricDef {
  event: string;
  kind: MetricKind;
  /** Which way is good. A guardrail is harmed when it moves the other way. */
  direction: 'increase' | 'decrease';
  /** Only events within this many hours of a user's first exposure count. Null = no limit. */
  windowHours: number | null;
  /** Ratio metrics only: the event counted in the denominator. */
  denominatorEvent: string | null;
  /** Mean and ratio metrics: per-user values above this percentile are capped. Null = no cap. */
  capPercentile: number | null;
}

/** An ordered rule checked before the experiment: matching users get `variant` and are not counted. */
export interface OverrideRule {
  conditions: Condition[];
  variant: string;
}

/** A slice of a mutual-exclusion group, in percent of users: [start, end). */
export interface Exclusion {
  group: string;
  start: number;
  end: number;
}

/** Users inside a holdout get the default variant of every flag that references it. */
export interface HoldoutRef {
  key: string;
  percent: number;
}

export type FlagStatus = 'draft' | 'running' | 'stopped' | 'rolled_out' | 'archived';

/** One analysis period. A restart closes the current phase and opens a new one with a fresh salt. */
export interface Phase {
  number: number;
  startedAt: number | null;
  endedAt: number | null;
  reason: string;
  /** The variants as they were when the phase closed, so an old phase is still read against its own split. */
  variants?: Variant[];
}

/** The sample size the experiment committed to. Locked once so the finish line cannot move. */
export interface SamplePlan {
  /** Expected control value: a rate for conversion metrics, a per-user mean otherwise. */
  baseline: number | null;
  /** Per-user standard deviation, needed to plan mean and ratio metrics. */
  baselineSd: number | null;
  requiredPerVariant: number | null;
  source: 'stated' | 'observed' | null;
  lockedAt: number | null;
}

export interface FlagConfig {
  key: string;
  description: string;
  /** Mirror of the lifecycle: true while running or rolled out. */
  enabled: boolean;
  status: FlagStatus;
  statusChangedAt: number | null;
  /** Mixed into every hash so two flags never bucket users identically. */
  salt: string;
  /** Percent (0-100) of eligible users who enter the experiment at all. */
  rolloutPercent: number;
  /** The first variant is treated as the control. */
  variants: Variant[];
  /** Served when the flag is off, targeting misses, or the user is outside the rollout. */
  defaultVariant: string;
  /** Served to everyone once the experiment is rolled out. */
  rolledOutVariant: string | null;
  targeting: Condition[];
  overrides: OverrideRule[];
  exclusion: Exclusion | null;
  holdout: HoldoutRef | null;
  /** Non-production environments where the flag evaluates as live (for QA before launch). */
  environments: string[];
  /** User attributes stored with each exposure so results can be split by them. */
  dimensions: string[];

  /** The metric that decides the experiment. */
  goal: MetricDef;
  /** Metrics that must not get worse. A significant regression blocks a ship. */
  guardrails: MetricDef[];
  /** Smallest relative lift worth detecting (0.1 = 10%). Drives the required sample size. */
  minDetectableEffect: number;
  /** A win is not called until users have been enrolled across at least this many days. */
  minRuntimeDays: number;
  /** Always-valid inference: results can be checked at any time without inflating false positives. */
  sequential: boolean;
  /** Use each user's pre-experiment behavior to remove noise from the comparison. */
  cuped: boolean;
  /** How far back (days before exposure) to look for pre-experiment behavior. */
  preExperimentDays: number;
  plan: SamplePlan;

  phase: number;
  phases: Phase[];
  /** Incremented on every change, recorded alongside each exposure. */
  version: number;
}

/** The fields evaluation needs. This is all an SDK is given. */
export type EvaluableFlag = Pick<
  FlagConfig,
  | 'key'
  | 'enabled'
  | 'status'
  | 'salt'
  | 'rolloutPercent'
  | 'variants'
  | 'defaultVariant'
  | 'rolledOutVariant'
  | 'targeting'
  | 'overrides'
  | 'exclusion'
  | 'holdout'
  | 'dimensions'
  | 'phase'
  | 'version'
>;

export type Attributes = Record<string, string | number | boolean>;

export interface UserContext {
  id: string;
  /**
   * A device or session id that existed before the user logged in. When set,
   * bucketing uses it, so logging in never moves a user to another variant.
   */
  anonymousId?: string;
  attributes?: Attributes;
}

export type EvaluationReason =
  | 'FLAG_DISABLED'
  | 'OVERRIDE'
  | 'ROLLED_OUT'
  | 'TARGETING_MISS'
  | 'HOLDOUT'
  | 'EXCLUDED'
  | 'OUTSIDE_ROLLOUT'
  | 'ASSIGNED';

export interface Evaluation {
  flagKey: string;
  variant: string;
  /** The variant's payload, if it has one. */
  value?: VariantValue;
  reason: EvaluationReason;
  /** True only when the user was assigned by the experiment and should be counted. */
  inExperiment: boolean;
  /** Variant bucket in [0, 10000), or null if the user never reached bucketing. */
  bucket: number | null;
  /** The id that was hashed and that the exposure is recorded under. */
  unitId: string;
  /** Set when the flag sits behind a holdout, so membership can be logged for the holdout readout. */
  holdout?: { key: string; held: boolean };
  /** The analysis phase the assignment belongs to. Exposures from an earlier phase are discarded. */
  phase: number;
  version: number;
}

/** Raw counts for one variant: how many users saw it and how many converted. */
export interface VariantCounts {
  variant: string;
  exposures: number;
  conversions: number;
}
