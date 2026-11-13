import type { ErrorCode, EvaluationContext, JsonValue, Provider, ResolutionDetails } from '@openfeature/server-sdk';
import type { Attributes, Evaluation, UserContext } from '../core/types.js';
import type { VerdictClient } from './index.js';

/**
 * An OpenFeature provider backed by a VerdictClient.
 *
 * OpenFeature is the vendor-neutral flag API. An application that already
 * calls `client.getStringValue('checkout', 'control', context)` can switch to
 * Verdict by registering this provider, with no changes at the call sites:
 *
 *   import { OpenFeature } from '@openfeature/server-sdk';
 *   await OpenFeature.setProviderAndWait(new VerdictProvider(new VerdictClient({ baseUrl })));
 *
 * Only OpenFeature's types are imported, so nothing is added at runtime.
 */

/** Verdict's evaluation reasons expressed in OpenFeature's standard vocabulary. */
const REASONS: Record<Evaluation['reason'], string> = {
  ASSIGNED: 'SPLIT',
  OVERRIDE: 'TARGETING_MATCH',
  ROLLED_OUT: 'STATIC',
  FLAG_DISABLED: 'DISABLED',
  TARGETING_MISS: 'DEFAULT',
  HOLDOUT: 'DEFAULT',
  EXCLUDED: 'DEFAULT',
  OUTSIDE_ROLLOUT: 'DEFAULT',
};

const error = <T>(value: T, code: 'TARGETING_KEY_MISSING' | 'FLAG_NOT_FOUND' | 'TYPE_MISMATCH', message: string, variant?: string): ResolutionDetails<T> => ({
  value,
  ...(variant ? { variant } : {}),
  reason: 'ERROR',
  errorCode: code as ErrorCode,
  errorMessage: message,
});

/** The targeting key is the user id; `anonymousId` is passed through; other primitive fields become attributes. */
function toUser(context: EvaluationContext): UserContext | undefined {
  if (!context.targetingKey) return undefined;
  const attributes: Attributes = {};
  let anonymousId: string | undefined;
  for (const [name, raw] of Object.entries(context)) {
    if (name === 'targetingKey') continue;
    if (name === 'anonymousId' && typeof raw === 'string') anonymousId = raw;
    else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') attributes[name] = raw;
  }
  return { id: context.targetingKey, ...(anonymousId ? { anonymousId } : {}), attributes };
}

export class VerdictProvider implements Provider {
  readonly metadata = { name: 'verdict' } as const;
  readonly runsOn = 'server' as const;

  constructor(private readonly client: VerdictClient) {}

  /** Load flag configs before the first evaluation. */
  async initialize(): Promise<void> {
    await this.client.refresh();
  }

  /** Send anything still queued when the application shuts down. */
  async onClose(): Promise<void> {
    await this.client.flush();
  }

  private resolve<T>(flagKey: string, defaultValue: T, context: EvaluationContext, read: (evaluation: Evaluation) => T | undefined): Promise<ResolutionDetails<T>> {
    const user = toUser(context);
    if (!user) return Promise.resolve(error(defaultValue, 'TARGETING_KEY_MISSING', 'Verdict needs a targetingKey to bucket the user.'));
    const evaluation = this.client.evaluate(flagKey, user);
    if (!evaluation) return Promise.resolve(error(defaultValue, 'FLAG_NOT_FOUND', `No flag named "${flagKey}".`));
    const value = read(evaluation);
    if (value === undefined) {
      return Promise.resolve(error(defaultValue, 'TYPE_MISMATCH', `Variant "${evaluation.variant}" of "${flagKey}" has no value of the requested type.`, evaluation.variant));
    }
    return Promise.resolve({
      value,
      variant: evaluation.variant,
      reason: REASONS[evaluation.reason],
      flagMetadata: { inExperiment: evaluation.inExperiment, version: evaluation.version, phase: evaluation.phase },
    });
  }

  /**
   * True when the variant's payload is `true`. Without a boolean payload, any
   * variant other than the control counts as "on".
   */
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, defaultValue, context, (e) => {
      if (typeof e.value === 'boolean') return e.value;
      if (e.value !== undefined) return undefined;
      return e.variant !== this.client.controlOf(flagKey);
    });
  }

  /** The variant's string payload, or the variant key itself when it has none. */
  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, defaultValue, context, (e) => (e.value === undefined ? e.variant : typeof e.value === 'string' ? e.value : undefined));
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, defaultValue, context, (e) => (typeof e.value === 'number' ? e.value : undefined));
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext): Promise<ResolutionDetails<T>> {
    return this.resolve(flagKey, defaultValue, context, (e) => (typeof e.value === 'object' && e.value !== null ? (e.value as T) : undefined));
  }
}
