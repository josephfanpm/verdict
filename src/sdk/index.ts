import { evaluate } from '../core/evaluate.js';
import type { Evaluation, FlagConfig, UserContext } from '../core/types.js';

export interface VerdictClientOptions {
  /** Base URL of a Verdict server, e.g. "http://localhost:3000". */
  baseUrl: string;
  /** Injected for tests or non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

interface QueuedExposure {
  flagKey: string;
  userId: string;
  variant: string;
  version: number;
  /** Client time of the exposure, so it orders correctly against client-timed events. */
  timestamp: number;
}

interface QueuedEvent {
  userId: string;
  event: string;
  value?: number;
  timestamp: number;
}

/**
 * Evaluates flags locally from a cached config, the way production SDKs do:
 * deciding a variant is a pure function call with zero network latency, and
 * exposures and events are batched and sent in the background.
 */
export class VerdictClient {
  private flags = new Map<string, FlagConfig>();
  private exposures: QueuedExposure[] = [];
  private events: QueuedEvent[] = [];
  /** Avoids re-sending an exposure the server would ignore anyway. */
  private seen = new Set<string>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VerdictClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Download the latest flag configs. Call once at startup, then periodically. */
  async refresh(): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/api/sdk/config`);
    if (!response.ok) throw new Error(`Verdict config request failed: ${response.status}`);
    const body = (await response.json()) as { flags: FlagConfig[] };
    this.flags = new Map(body.flags.map((f) => [f.key, f]));
  }

  /**
   * Return the variant key for this user. Unknown flags fall back to
   * `fallback`, so an outage or typo degrades to default behavior instead of
   * crashing the app.
   */
  variant(flagKey: string, user: UserContext, fallback = 'control'): string {
    return this.evaluate(flagKey, user)?.variant ?? fallback;
  }

  evaluate(flagKey: string, user: UserContext): Evaluation | undefined {
    const flag = this.flags.get(flagKey);
    if (!flag) return undefined;

    const result = evaluate(flag, user);
    const dedupeKey = `${flagKey}:${flag.version}:${user.id}`;
    if (result.inExperiment && !this.seen.has(dedupeKey)) {
      this.seen.add(dedupeKey);
      this.exposures.push({ flagKey, userId: user.id, variant: result.variant, version: flag.version, timestamp: Date.now() });
    }
    return result;
  }

  track(userId: string, event: string, value?: number): void {
    this.events.push({ userId, event, value, timestamp: Date.now() });
  }

  /** Send queued exposures, then events, so conversions never land before their exposure. */
  async flush(): Promise<void> {
    const exposures = this.exposures.splice(0);
    const events = this.events.splice(0);
    if (exposures.length) await this.post('/api/exposures', { exposures });
    if (events.length) await this.post('/api/track', { events });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Verdict ${path} failed: ${response.status}`);
  }
}
