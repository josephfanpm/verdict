import { describe, expect, it } from 'vitest';
import { evaluate, validateFlag } from '../src/core/evaluate.js';
import { normalizeFlag, type FlagInput } from '../src/core/flag.js';
import type { FlagConfig } from '../src/core/types.js';

function flag(overrides: Partial<FlagInput> = {}): FlagConfig {
  return normalizeFlag({ key: 'test-flag', enabled: true, salt: 'abc', ...overrides });
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

describe('evaluation order', () => {
  const staff = { conditions: [{ attribute: 'email', operator: 'contains' as const, values: ['@acme.com'] }], variant: 'treatment' };

  it('forces a variant for override matches without counting them, even before launch', () => {
    const draft = flag({ enabled: false, overrides: [staff] });
    const result = evaluate(draft, { id: 'u1', attributes: { email: 'qa@acme.com' } });
    expect(result).toMatchObject({ variant: 'treatment', reason: 'OVERRIDE', inExperiment: false });
    expect(evaluate(draft, { id: 'u1', attributes: { email: 'someone@else.com' } }).reason).toBe('FLAG_DISABLED');
  });

  it('serves the shipped variant to everyone once rolled out', () => {
    const shipped = flag({ status: 'rolled_out', rolledOutVariant: 'treatment' });
    for (const user of users.slice(0, 200)) {
      expect(evaluate(shipped, user)).toMatchObject({ variant: 'treatment', reason: 'ROLLED_OUT', inExperiment: false });
    }
  });

  it('returns the variant payload when there is one', () => {
    const f = flag({
      variants: [
        { key: 'control', weight: 50, value: { columns: 3 } },
        { key: 'treatment', weight: 50, value: { columns: 1 } },
      ],
    });
    const result = evaluate(f, { id: 'user-1' });
    expect(result.value).toEqual({ columns: result.variant === 'control' ? 3 : 1 });
  });

  it('buckets on the anonymous id so logging in does not change the variant', () => {
    const f = flag();
    for (let i = 0; i < 500; i++) {
      const before = evaluate(f, { id: `anon-${i}` });
      const after = evaluate(f, { id: `account-${i}`, anonymousId: `anon-${i}` });
      expect(after.variant).toBe(before.variant);
      expect(after.unitId).toBe(`anon-${i}`);
    }
  });
});

describe('holdouts', () => {
  it('holds back the same users from every flag that shares the holdout', () => {
    const a = flag({ salt: 'one', holdout: { key: 'h1', percent: 10 } });
    const b = flag({ salt: 'two', holdout: { key: 'h1', percent: 10 } });
    let held = 0;
    for (const user of users) {
      const ra = evaluate(a, user);
      const rb = evaluate(b, user);
      expect(ra.holdout!.held).toBe(rb.holdout!.held);
      if (ra.holdout!.held) {
        held++;
        expect(ra).toMatchObject({ variant: 'control', reason: 'HOLDOUT', inExperiment: false });
      }
    }
    expect(held / users.length).toBeCloseTo(0.1, 1);
  });
});

describe('mutual exclusion', () => {
  it('never puts one user in two experiments that share a group', () => {
    const a = flag({ salt: 'one', exclusion: { group: 'checkout', start: 0, end: 50 } });
    const b = flag({ salt: 'two', exclusion: { group: 'checkout', start: 50, end: 100 } });
    let inA = 0;
    for (const user of users) {
      const ra = evaluate(a, user);
      const rb = evaluate(b, user);
      expect(ra.inExperiment && rb.inExperiment).toBe(false);
      expect(ra.inExperiment || rb.inExperiment).toBe(true);
      if (ra.inExperiment) inA++;
    }
    expect(inA / users.length).toBeCloseTo(0.5, 1);
  });

  it('keeps the split inside a slice balanced', () => {
    const f = flag({ exclusion: { group: 'g', start: 0, end: 30 } });
    const assigned = users.map((u) => evaluate(f, u)).filter((r) => r.inExperiment);
    expect(assigned.filter((r) => r.variant === 'treatment').length / assigned.length).toBeCloseTo(0.5, 1);
  });
});

describe('validateFlag for the experiment settings', () => {
  it('rejects broken metrics, overrides and ranges', () => {
    const errors = validateFlag(
      flag({
        goal: { event: 'revenue', kind: 'ratio' },
        overrides: [{ conditions: [], variant: 'nope' }],
        exclusion: { group: 'g', start: 60, end: 40 },
        minRuntimeDays: 400,
      })
    );
    expect(errors.join(' ')).toMatch(/denominator/);
    expect(errors.join(' ')).toMatch(/not one of the variants/);
    expect(errors.join(' ')).toMatch(/at least one condition/);
    expect(errors.join(' ')).toMatch(/Exclusion range/);
    expect(errors.join(' ')).toMatch(/Minimum runtime/);
  });
});
