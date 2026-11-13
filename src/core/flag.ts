import type { FlagConfig, FlagStatus, MetricDef, SamplePlan } from './types.js';

/** A metric given as just an event name, or with any of its options. */
export type MetricInput = string | (Partial<MetricDef> & { event: string });

/** Fill in a metric's defaults. Mean and ratio metrics are capped at the 99th percentile unless told otherwise. */
export function metric(input: MetricInput): MetricDef {
  const m = typeof input === 'string' ? { event: input } : input;
  const kind = m.kind ?? 'conversion';
  return {
    event: m.event,
    kind,
    direction: m.direction ?? 'increase',
    windowHours: m.windowHours ?? null,
    denominatorEvent: kind === 'ratio' ? (m.denominatorEvent ?? null) : null,
    capPercentile: kind === 'conversion' ? null : m.capPercentile === undefined ? 0.99 : m.capPercentile,
  };
}

export type FlagInput = Partial<Omit<FlagConfig, 'goal' | 'guardrails' | 'plan'>> & {
  key: string;
  /** Shorthand for a conversion goal on this event. */
  primaryMetric?: string;
  goal?: MetricInput;
  guardrails?: MetricInput[];
  plan?: Partial<SamplePlan>;
};

export const DEFAULT_MIN_RUNTIME_DAYS = 7;
export const DEFAULT_PRE_EXPERIMENT_DAYS = 14;

/**
 * Build a complete flag from a partial one. Used for new flags, for test
 * fixtures, and to upgrade configs stored by older versions.
 */
export function normalizeFlag(input: FlagInput): FlagConfig {
  const variants = input.variants ?? [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ];
  const status: FlagStatus = input.status ?? (input.enabled ? 'running' : 'draft');
  const phase = input.phase ?? 1;

  return {
    key: input.key,
    description: input.description ?? '',
    enabled: status === 'running' || status === 'rolled_out',
    status,
    statusChangedAt: input.statusChangedAt ?? null,
    salt: input.salt ?? input.key,
    rolloutPercent: input.rolloutPercent ?? 100,
    variants,
    defaultVariant: input.defaultVariant ?? variants[0]?.key ?? 'control',
    rolledOutVariant: input.rolledOutVariant ?? null,
    targeting: input.targeting ?? [],
    overrides: input.overrides ?? [],
    exclusion: input.exclusion ?? null,
    holdout: input.holdout ?? null,
    environments: input.environments ?? [],
    dimensions: input.dimensions ?? [],
    goal: metric(input.goal ?? input.primaryMetric ?? 'conversion'),
    guardrails: (input.guardrails ?? []).map(metric),
    minDetectableEffect: input.minDetectableEffect ?? 0.1,
    minRuntimeDays: input.minRuntimeDays ?? DEFAULT_MIN_RUNTIME_DAYS,
    sequential: input.sequential ?? true,
    cuped: input.cuped ?? true,
    preExperimentDays: input.preExperimentDays ?? DEFAULT_PRE_EXPERIMENT_DAYS,
    plan: {
      baseline: input.plan?.baseline ?? null,
      baselineSd: input.plan?.baselineSd ?? null,
      requiredPerVariant: input.plan?.requiredPerVariant ?? null,
      source: input.plan?.source ?? null,
      lockedAt: input.plan?.lockedAt ?? null,
    },
    phase,
    phases: input.phases ?? [{ number: phase, startedAt: null, endedAt: null, reason: 'Created' }],
    version: input.version ?? 1,
  };
}

/** A short label for a metric: "purchase", "order value per user", "order value / session". */
export function metricLabel(m: MetricDef): string {
  if (m.kind === 'ratio') return `${m.event} value / ${m.denominatorEvent ?? '?'}`;
  return m.kind === 'mean' ? `${m.event} value per user` : m.event;
}
