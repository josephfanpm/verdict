import { describe, expect, it } from 'vitest';
import { evaluate, validateFlag } from '../src/core/evaluate.js';
import type { FlagConfig } from '../src/core/types.js';

function flag(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    key: 'test-flag',
    description: '',
    enabled: true,
    salt: 'abc',
    rolloutPercent: 100,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ],
    defaultVariant: 'control',
    targeting: [],
    primaryMetric: 'conversion',
    minDetectableEffect: 0.1,
    version: 1,
    ...overrides,
  };
}

const users = Array.from({ length: 20_000 }, (_, i) => ({ id: `user-${i}` }));

describe('evaluate', () => {
  it('serves the default variant when the flag is disabled', () => {
    const result = evaluate(flag({ enabled: false }), { id: 'u1' });
    expect(result).toMatchObject({ variant: 'control', reason: 'FLAG_DISABLED', inExperiment: false });
  });

  it('serves the default variant when targeting does not match', () => {
    const f = flag({ targeting: [{ attribute: 'country', operator: 'in', values: ['US', 'CA'] }] });
    expect(evaluate(f, { id: 'u1', attributes: { country: 'GB' } }).reason).toBe('TARGETING_MISS');
    expect(evaluate(f, { id: 'u1' }).reason).toBe('TARGETING_MISS');
    expect(evaluate(f, { id: 'u1', attributes: { country: 'US' } }).reason).toBe('ASSIGNED');
  });

  it('supports numeric targeting', () => {
    const f = flag({ targeting: [{ attribute: 'age', operator: 'gt', values: [17] }] });
    expect(evaluate(f, { id: 'u1', attributes: { age: 18 } }).inExperiment).toBe(true);
    expect(evaluate(f, { id: 'u1', attributes: { age: 17 } }).inExperiment).toBe(false);
  });

  it('always gives the same user the same variant', () => {
    const f = flag();
    const first = evaluate(f, { id: 'user-42' }).variant;
    for (let i = 0; i < 100; i++) expect(evaluate(f, { id: 'user-42' }).variant).toBe(first);
  });

  it('splits traffic according to the weights', () => {
    const f = flag({
      variants: [
        { key: 'control', weight: 80 },
        { key: 'treatment', weight: 20 },
      ],
    });
    const treated = users.filter((u) => evaluate(f, u).variant === 'treatment').length;
    expect(treated / users.length).toBeCloseTo(0.2, 1);
  });

  it('covers every bucket when weights are fractional', () => {
    const third = 100 / 3;
    const f = flag({
      variants: [
        { key: 'a', weight: third },
        { key: 'b', weight: third },
        { key: 'c', weight: third },
      ],
      defaultVariant: 'a',
    });
    expect(validateFlag(f)).toEqual([]);
    expect(() => users.forEach((u) => evaluate(f, u))).not.toThrow();
  });

  it('includes roughly rolloutPercent of users', () => {
    const f = flag({ rolloutPercent: 10 });
    const included = users.filter((u) => evaluate(f, u).inExperiment).length;
    expect(included / users.length).toBeGreaterThan(0.09);
    expect(included / users.length).toBeLessThan(0.11);
  });

  it('keeps existing users in their variant when the rollout is raised', () => {
    const at10 = flag({ rolloutPercent: 10 });
    const at50 = flag({ rolloutPercent: 50 });
    for (const user of users) {
      const before = evaluate(at10, user);
      if (!before.inExperiment) continue;
      const after = evaluate(at50, user);
      expect(after.inExperiment).toBe(true);
      expect(after.variant).toBe(before.variant);
    }
  });

  it('buckets independently for different salts', () => {
    const a = flag({ salt: 'one' });
    const b = flag({ salt: 'two' });
    const agree = users.filter((u) => evaluate(a, u).variant === evaluate(b, u).variant).length;
    expect(agree / users.length).toBeCloseTo(0.5, 1);
  });
});

describe('validateFlag', () => {
  it('accepts a valid flag', () => {
    expect(validateFlag(flag())).toEqual([]);
  });

  it('rejects weights that do not sum to 100', () => {
    const errors = validateFlag(
      flag({
        variants: [
          { key: 'control', weight: 50 },
          { key: 'treatment', weight: 40 },
        ],
      })
    );
    expect(errors.join(' ')).toMatch(/sum to 100/);
  });

  it('rejects duplicate keys, bad defaults and bad flag keys', () => {
    const errors = validateFlag(
      flag({
        key: 'Bad Key',
        defaultVariant: 'missing',
        variants: [
          { key: 'a', weight: 50 },
          { key: 'a', weight: 50 },
        ],
      })
    );
    expect(errors).toHaveLength(3);
  });
});
