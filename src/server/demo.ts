import { evaluate, exposureAttributes } from '../core/evaluate.js';
import { metric, normalizeFlag, type FlagInput } from '../core/flag.js';
import type { Attributes } from '../core/types.js';
import { HOLDOUT_PREFIX, HOLDOUT_VARIANTS, type Store } from './store.js';

/**
 * Synthetic experiments that each exercise a different branch of the decision
 * engine. The random generator is seeded, so the demo is identical every run.
 */
interface SimulatedEvent {
  event: string;
  value?: number;
  /** Milliseconds after exposure. Negative = before exposure (pre-experiment behavior). */
  after: number;
}

interface Scenario {
  flag: FlagInput;
  users: number;
  /** What a user does, given the variant they experienced ("control" for held-out users). */
  behave: (variant: string, random: () => number, attributes: Attributes) => SimulatedEvent[];
  /** Fraction of exposures that never get logged, to simulate an instrumentation bug. */
  exposureLoss?: (variant: string, attributes: Attributes) => number;
  /** Lifecycle state to end in, with the time it was reached. */
  ending?: { status: 'rolled_out' | 'stopped'; variant?: string; daysAfterStart: number };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** One yes/no event with a per-variant probability. */
function converts(event: string, rates: Record<string, number>) {
  return (variant: string, random: () => number): SimulatedEvent[] => (random() < (rates[variant] ?? 0) ? [{ event, after: MINUTE }] : []);
}

const SCENARIOS: Scenario[] = [
  {
    // A clean win: goal up, guardrails flat, enough users, enough days.
    flag: {
      key: 'checkout-redesign',
      description: 'One-page checkout replacing the three-step flow.',
      salt: 'demo-checkout',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'one-page', weight: 50 },
      ],
      goal: { event: 'purchase', windowHours: 168 },
      guardrails: [
        { event: 'refund', direction: 'decrease' },
        { event: 'support_ticket', direction: 'decrease' },
      ],
      minDetectableEffect: 0.1,
      plan: { baseline: 0.1 },
      dimensions: ['country', 'plan'],
      holdout: { key: 'growth-2026', percent: 5 },
      overrides: [{ conditions: [{ attribute: 'email', operator: 'contains', values: ['@verdict.dev'] }], variant: 'one-page' }],
    },
    users: 40_000,
    behave: (variant, random) => {
      // Some users are habitual buyers. Their past purchases predict their
      // future ones, which is exactly the noise CUPED removes.
      const habitual = random() < 0.3;
      const events: SimulatedEvent[] = [];
      if (random() < (habitual ? 0.6 : 0.02)) events.push({ event: 'purchase', after: -Math.ceil(random() * 10) * DAY });
      const rate = (habitual ? 0.27 : 0.03) * (variant === 'one-page' ? 1.15 : 1);
      if (random() < rate) {
        events.push({ event: 'purchase', after: Math.ceil(random() * 60) * MINUTE });
        if (random() < 0.03) events.push({ event: 'refund', after: 2 * DAY });
      }
      if (random() < 0.02) events.push({ event: 'support_ticket', after: 3 * 60 * MINUTE });
      return events;
    },
  },
  {
    // A broken split. The lift looks good; the data is not.
    flag: {
      key: 'onboarding-checklist',
      description: 'Guided checklist vs. video tour for new sign-ups.',
      salt: 'demo-onboarding',
      variants: [
        { key: 'control', weight: 34 },
        { key: 'checklist', weight: 33 },
        { key: 'video-tour', weight: 33 },
      ],
      targeting: [{ attribute: 'plan', operator: 'equals', values: ['free'] }],
      goal: 'onboarding_complete',
      minDetectableEffect: 0.08,
      dimensions: ['browser'],
    },
    users: 36_000,
    behave: converts('onboarding_complete', { control: 0.3, checklist: 0.33, 'video-tour': 0.31 }),
    // The video player crashes on Safari before the exposure is logged.
    exposureLoss: (variant, attributes) => (variant === 'video-tour' && attributes.browser === 'safari' ? 0.3 : 0),
  },
  {
    // Still ramping: not enough users to call anything.
    flag: {
      key: 'pricing-page-copy',
      description: 'Value-led headline on the pricing page. Ramping at 25%.',
      salt: 'demo-pricing',
      rolloutPercent: 25,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'value-headline', weight: 50 },
      ],
      goal: 'pricing_cta_click',
      minDetectableEffect: 0.15,
    },
    users: 16_000,
    behave: converts('pricing_cta_click', { control: 0.06, 'value-headline': 0.064 }),
  },
  {
    // The goal itself gets worse.
    flag: {
      key: 'search-ranking-v2',
      description: 'New relevance model for marketplace search.',
      salt: 'demo-search',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'ranking-v2', weight: 50 },
      ],
      targeting: [{ attribute: 'country', operator: 'in', values: ['US', 'CA'] }],
      goal: 'search_click',
      minDetectableEffect: 0.05,
    },
    users: 20_000,
    behave: converts('search_click', { control: 0.2, 'ranking-v2': 0.172 }),
  },
  {
    // The goal wins and a guardrail breaks: more orders, and more of them refunded.
    flag: {
      key: 'free-shipping-banner',
      description: 'Sitewide free-shipping banner. Lifts orders, but watch refunds.',
      salt: 'demo-shipping',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'banner', weight: 50 },
      ],
      goal: 'order_placed',
      guardrails: [{ event: 'order_refunded', direction: 'decrease' }],
      minDetectableEffect: 0.1,
      dimensions: ['country'],
    },
    users: 30_000,
    behave: (variant, random) => {
      const events: SimulatedEvent[] = [];
      if (random() < (variant === 'banner' ? 0.098 : 0.08)) events.push({ event: 'order_placed', after: 5 * MINUTE });
      if (random() < (variant === 'banner' ? 0.034 : 0.02)) events.push({ event: 'order_refunded', after: 4 * DAY });
      return events;
    },
  },
  {
    // A revenue goal: the same share of users order, but they spend more.
    flag: {
      key: 'bundle-upsell',
      description: 'Suggest a bundle in the cart. Goal is revenue per user, not orders.',
      salt: 'demo-bundle',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'bundle', weight: 50 },
      ],
      goal: { event: 'order', kind: 'mean' },
      guardrails: ['order'],
      minDetectableEffect: 0.1,
    },
    users: 50_000,
    behave: (variant, random) => {
      if (random() >= 0.12) return [];
      // Skewed order sizes, with the occasional very large one that capping keeps in check.
      const size = random() < 0.002 ? 4_000 : 15 + -Math.log(1 - random()) * 28;
      return [{ event: 'order', value: Math.round(size * (variant === 'bundle' ? 1.16 : 1) * 100) / 100, after: 10 * MINUTE }];
    },
  },
  {
    // Decided and shipped a while ago, but the flag is still in code.
    flag: {
      key: 'new-navigation',
      description: 'Sidebar navigation replacing the top bar.',
      salt: 'demo-navigation',
      variants: [
        { key: 'top-bar', weight: 50 },
        { key: 'sidebar', weight: 50 },
      ],
      goal: 'feature_discovered',
      minDetectableEffect: 0.1,
    },
    users: 14_000,
    behave: converts('feature_discovered', { 'top-bar': 0.25, sidebar: 0.3 }),
    ending: { status: 'rolled_out', variant: 'sidebar', daysAfterStart: 16 },
  },
  {
    flag: {
      key: 'dark-mode',
      description: 'Dark theme toggle. Built, not launched yet.',
      salt: 'demo-dark-mode',
      rolloutPercent: 10,
      variants: [
        { key: 'off', weight: 50, value: false },
        { key: 'on', weight: 50, value: true },
      ],
      goal: 'session_length_over_5m',
      minDetectableEffect: 0.05,
      status: 'draft',
    },
    users: 0,
    behave: () => [],
  },
];

const DEMO_SPAN_MS = 14 * DAY;

const COUNTRIES = ['US', 'US', 'US', 'CA', 'GB', 'DE'];
const PLANS = ['free', 'free', 'free', 'pro'];
const BROWSERS = ['chrome', 'chrome', 'safari', 'firefox', 'chrome'];

/** Small, fast, seedable PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemo(store: Store, startTs = Date.UTC(2026, 8, 1)): void {
  store.transaction(() => {
    if (!store.getHoldout('growth-2026')) {
      store.insertHoldout({
        key: 'growth-2026',
        description: 'Users who get none of the 2026 growth experiments.',
        percent: 5,
        metric: metric('purchase'),
        createdAt: startTs,
      });
    }

    SCENARIOS.forEach((scenario, s) => {
      if (store.getFlag(scenario.flag.key)) return;
      const started = scenario.flag.status !== 'draft';
      const flag = normalizeFlag({
        status: 'running',
        statusChangedAt: started ? startTs : null,
        phases: [{ number: 1, startedAt: started ? startTs : null, endedAt: null, reason: 'Created' }],
        ...scenario.flag,
      });
      store.insertFlag(flag, startTs + s);
      store.addAudit(flag.key, 1, 'Flag created (demo data)', startTs);

      const random = rng(1000 + s);
      // Each scenario has its own users, so one experiment's events never leak into another's metrics.
      const prefix = flag.key.split('-')[0]!;
      for (let i = 0; i < scenario.users; i++) {
        const userId = `${prefix}-${i}`;
        const attributes = { country: COUNTRIES[i % COUNTRIES.length]!, plan: PLANS[(i * 7) % PLANS.length]!, browser: BROWSERS[(i * 3) % BROWSERS.length]! };
        const result = evaluate(flag, { id: userId, attributes });
        // Spread arrivals across two weeks so the dashboard's charts have a real timeline.
        const ts = startTs + Math.floor((i / Math.max(1, scenario.users)) * DEMO_SPAN_MS);

        if (result.holdout) {
          store.recordExposure(HOLDOUT_PREFIX + result.holdout.key, 0, userId, result.holdout.held ? HOLDOUT_VARIANTS.held : HOLDOUT_VARIANTS.exposed, 0, ts);
        }
        // Held-out users still use the product; they just get the default experience.
        if (!result.inExperiment && !result.holdout?.held) continue;
        const lost = result.inExperiment && random() < (scenario.exposureLoss?.(result.variant, attributes) ?? 0);
        if (lost) continue;

        if (result.inExperiment) {
          store.recordExposure(flag.key, flag.phase, userId, result.variant, flag.version, ts, exposureAttributes(flag, { id: userId, attributes }));
        }
        for (const e of scenario.behave(result.variant, random, attributes)) {
          store.recordEvent(userId, e.event, e.value ?? null, ts + e.after);
        }
      }

      if (scenario.ending) {
        const at = startTs + scenario.ending.daysAfterStart * DAY;
        const ended = { ...flag, status: scenario.ending.status, enabled: scenario.ending.status === 'rolled_out', statusChangedAt: at, rolledOutVariant: scenario.ending.variant ?? null, version: 2 };
        store.updateFlag(ended, at);
        store.addAudit(flag.key, 2, scenario.ending.variant ? `Rolled out ${scenario.ending.variant} to everyone` : 'Experiment stopped', at);
      }
    });
  });
}
