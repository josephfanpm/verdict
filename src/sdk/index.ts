import { evaluate, exposureAttributes } from '../core/evaluate.js';
import type { EvaluableFlag, Evaluation, UserContext, VariantValue } from '../core/types.js';

export interface VerdictClientOptions {
  /** Base URL of a Verdict server, e.g. "http://localhost:3000". */
  baseUrl: string;
  /** Identifies the environment this client runs in. Required once the server has SDK keys. */
  sdkKey?: string;
  /** Injected for tests or non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

interface QueuedExposure {
  flagKey: string;
  userId: string;
  variant: string;
  version: number;
  phase?: number;
  /** Client time of the exposure, so it orders correctly against client-timed events. */
  timestamp: number;
  attributes?: Record<string, string>;
}

interface QueuedEvent {
  userId: string;
  event: string;
  value?: number;
  timestamp: number;
  /** Lets the server drop a repeat if a flush is retried after a network failure. */
  idempotencyKey: string;
}

interface QueuedIdentity {
  anonymousId: string;
  userId: string;
}

const HOLDOUT_PREFIX = 'holdout:';

function uniqueId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * Evaluates flags locally from a cached config, the way production SDKs do:
 * deciding a variant is a pure function call with zero network latency, and
 * exposures and events are batched and sent in the background.
 */
export class VerdictClient {
  private flags = new Map<string, EvaluableFlag>();
  private exposures: QueuedExposure[] = [];
  private events: QueuedEvent[] = [];
  private identities: QueuedIdentity[] = [];
  /** Avoids re-sending an exposure or identity link the server already has. */
  private seen = new Set<string>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VerdictClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.options.sdkKey ? { 'x-sdk-key': this.options.sdkKey } : {}),
    };
  }

  /** Download the latest flag configs. Call once at startup, then periodically. */
  async refresh(): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/api/sdk/config`, { headers: this.headers() });
    if (!response.ok) throw new Error(`Verdict config request failed: ${response.status}`);
    const body = (await response.json()) as { flags: EvaluableFlag[] };
    this.flags = new Map(body.flags.map((f) => [f.key, f]));
  }

  /** Keys of every flag in the cached config. */
  flagKeys(): string[] {
    return [...this.flags.keys()];
  }

  /** The control variant of a flag (its first variant), or undefined if the flag is unknown. */
  controlOf(flagKey: string): string | undefined {
    return this.flags.get(flagKey)?.variants[0]?.key;
  }

  /**
   * Return the variant key for this user. Unknown flags fall back to
   * `fallback`, so an outage or typo degrades to default behavior instead of
   * crashing the app.
   */
  variant(flagKey: string, user: UserContext, fallback = 'control'): string {
    return this.evaluate(flagKey, user)?.variant ?? fallback;
  }

  /** Return the assigned variant's payload, or `fallback` if the flag is unknown or the variant has none. */
  value<T extends VariantValue>(flagKey: string, user: UserContext, fallback: T): T {
    const result = this.evaluate(flagKey, user);
    return result?.value === undefined ? fallback : (result.value as T);
  }

  evaluate(flagKey: string, user: UserContext): Evaluation | undefined {
    const flag = this.flags.get(flagKey);
    if (!flag) return undefined;

    const result = evaluate(flag, user);
    const timestamp = Date.now();

    // A user known by two ids is one person: tell the server once so their
    // pre-login exposure and post-login conversions are joined.
    if (user.anonymousId && user.anonymousId !== user.id && this.once(`id:${user.anonymousId}:${user.id}`)) {
      this.identities.push({ anonymousId: user.anonymousId, userId: user.id });
    }
    if (result.holdout && this.once(`${HOLDOUT_PREFIX}${result.holdout.key}:${result.unitId}`)) {
      this.exposures.push({
        flagKey: HOLDOUT_PREFIX + result.holdout.key,
        userId: result.unitId,
        variant: result.holdout.held ? 'holdout' : 'exposed',
        version: 0,
        timestamp,
      });
    }
    if (result.inExperiment && this.once(`${flagKey}:${flag.version}:${result.unitId}`)) {
      this.exposures.push({
        flagKey,
        userId: result.unitId,
        variant: result.variant,
        version: flag.version,
        phase: flag.phase,
        timestamp,
        attributes: exposureAttributes(flag, user),
      });
    }
    return result;
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  track(userId: string, event: string, value?: number): void {
    this.events.push({ userId, event, value, timestamp: Date.now(), idempotencyKey: uniqueId() });
  }

  /** Link an anonymous id to the account it became. Call when a user signs up or logs in. */
  identify(anonymousId: string, userId: string): void {
    if (anonymousId !== userId && this.once(`id:${anonymousId}:${userId}`)) this.identities.push({ anonymousId, userId });
  }

  /**
   * Send what is queued: identity links, then exposures, then events, so
   * conversions never land before their exposure. Anything that fails to send
   * goes back in the queue for the next flush; nothing is dropped, and events
   * carry an idempotency key so a retry cannot count twice.
   */
  async flush(): Promise<void> {
    const identities = this.identities.splice(0);
    const exposures = this.exposures.splice(0);
    const events = this.events.splice(0);
    try {
      while (identities.length) {
        await this.post('/api/identify', identities[0]);
        identities.shift();
      }
      if (exposures.length) {
        await this.post('/api/exposures', { exposures });
        exposures.length = 0;
      }
      if (events.length) {
        await this.post('/api/track', { events });
        events.length = 0;
      }
    } finally {
      this.identities.unshift(...identities);
      this.exposures.unshift(...exposures);
      this.events.unshift(...events);
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Verdict ${path} failed: ${response.status}`);
  }
}
