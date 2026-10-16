import { evaluate } from '../core/evaluate.js';
import type { FlagConfig } from '../core/types.js';
import type { Store } from './store.js';

/**
 * Synthetic experiments that each exercise a different branch of the decision
 * engine. The random generator is seeded, so the demo is identical every run.
 */
interface Scenario {
  flag: Omit<FlagConfig, 'version'>;
  users: number;
  /** True conversion rate for each variant. */
  trueRates: Record<string, number>;
  /** Fraction of a variant's exposures that never get logged, to simulate an instrumentation bug. */
  exposureLoss?: Record<string, number>;
}

const SCENARIOS: Scenario[] = [
  {
    flag: {
      key: 'checkout-redesign',
      description: 'One-page checkout replacing the three-step flow.',
      enabled: true,
      salt: 'demo-checkout',
      rolloutPercent: 100,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'one-page', weight: 50 },
      ],
      defaultVariant: 'control',
      targeting: [],
      primaryMetric: 'purchase',
      minDetectableEffect: 0.1,
    },
    users: 40_000,
    trueRates: { control: 0.1, 'one-page': 0.115 },
  },
  {
    flag: {
      key: 'onboarding-checklist',
      description: 'Guided checklist vs. video tour for new sign-ups.',
      enabled: true,
      salt: 'demo-onboarding',
      rolloutPercent: 100,
      variants: [
        { key: 'control', weight: 34 },
        { key: 'checklist', weight: 33 },
        { key: 'video-tour', weight: 33 },
      ],
      defaultVariant: 'control',
      targeting: [{ attribute: 'plan', operator: 'equals', values: ['free'] }],
      primaryMetric: 'onboarding_complete',
      minDetectableEffect: 0.08,
    },
    users: 36_000,
    trueRates: { control: 0.3, checklist: 0.33, 'video-tour': 0.31 },
    // The video player crashes on some browsers before the exposure is logged.
    exposureLoss: { 'video-tour': 0.07 },
  },
  {
    flag: {
      key: 'pricing-page-copy',
      description: 'Value-led headline on the pricing page. Ramping at 25%.',
      enabled: true,
      salt: 'demo-pricing',
      rolloutPercent: 25,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'value-headline', weight: 50 },
      ],
      defaultVariant: 'control',
      targeting: [],
      primaryMetric: 'pricing_cta_click',
      minDetectableEffect: 0.15,
    },
    users: 16_000,
    trueRates: { control: 0.06, 'value-headline': 0.064 },
  },
  {
    flag: {
      key: 'search-ranking-v2',
      description: 'New relevance model for marketplace search.',
      enabled: true,
      salt: 'demo-search',
      rolloutPercent: 100,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'ranking-v2', weight: 50 },
      ],
      defaultVariant: 'control',
      targeting: [{ attribute: 'country', operator: 'in', values: ['US', 'CA'] }],
      primaryMetric: 'search_click',
      minDetectableEffect: 0.05,
    },
    users: 20_000,
    trueRates: { control: 0.2, 'ranking-v2': 0.172 },
  },
  {
    flag: {
      key: 'dark-mode',
      description: 'Dark theme toggle. Built, not launched yet.',
      enabled: false,
      salt: 'demo-dark-mode',
      rolloutPercent: 10,
      variants: [
        { key: 'off', weight: 50 },
        { key: 'on', weight: 50 },
      ],
      defaultVariant: 'off',
      targeting: [],
      primaryMetric: 'session_length_over_5m',
      minDetectableEffect: 0.05,
    },
    users: 0,
    trueRates: { off: 0, on: 0 },
  },
];

const COUNTRIES = ['US', 'US', 'US', 'CA', 'GB', 'DE'];
const PLANS = ['free', 'free', 'free', 'pro'];

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
    SCENARIOS.forEach((scenario, s) => {
      if (store.getFlag(scenario.flag.key)) return;
      const flag: FlagConfig = { ...scenario.flag, version: 1 };
      store.insertFlag(flag, startTs + s);
      store.addAudit(flag.key, 1, 'Flag created (demo data)', startTs);

      const random = rng(1000 + s);
      for (let i = 0; i < scenario.users; i++) {
        const userId = `user-${i}`;
        const attributes = { country: COUNTRIES[i % COUNTRIES.length]!, plan: PLANS[(i * 7) % PLANS.length]! };
        const result = evaluate(flag, { id: userId, attributes });
        if (!result.inExperiment) continue;
        if (random() < (scenario.exposureLoss?.[result.variant] ?? 0)) continue;

        const ts = startTs + i * 1_000;
        store.recordExposure(flag.key, userId, result.variant, flag.version, ts);
        if (random() < scenario.trueRates[result.variant]!) {
          store.recordEvent(userId, flag.primaryMetric, null, ts + 60_000);
        }
      }
    });
  });
}
