import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

const DAY = 86_400_000;
let app: FastifyInstance;
/** The server's clock, so tests can move time forward. */
let clock = Date.now();

beforeEach(() => {
  clock = Date.now();
  app = buildApp({ now: () => clock });
});

afterEach(async () => {
  await app.close();
});

async function createFlag(body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/flags', payload: { key: 'checkout', enabled: true, primaryMetric: 'purchase', ...body } });
}

async function evaluateUser(userId: string, query = '', flagKey = 'checkout', extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: `/api/evaluate${query}`, payload: { flagKey, user: { id: userId, ...extra } } });
  return res.json();
}

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers });
const track = (userId: string, event: string, extra: Record<string, unknown> = {}) => post('/api/track', { userId, event, ...extra });

describe('flags API', () => {
  it('creates a flag with sensible defaults', async () => {
    const res = await createFlag();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      key: 'checkout',
      version: 1,
      status: 'running',
      defaultVariant: 'control',
      goal: { event: 'purchase', kind: 'conversion', direction: 'increase' },
      guardrails: [],
      sequential: true,
      minRuntimeDays: 7,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'treatment', weight: 50 },
      ],
    });
  });

  it('rejects invalid flags with a readable message', async () => {
    const res = await createFlag({
      variants: [
        { key: 'a', weight: 60 },
        { key: 'b', weight: 60 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/sum to 100/);
  });

  it('rejects duplicate keys', async () => {
    await createFlag();
    expect((await createFlag()).statusCode).toBe(409);
  });

  it('returns 404 for unknown flags', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/flags/nope' })).statusCode).toBe(404);
  });

  it('accepts guardrails and richer goal metrics', async () => {
    const res = await createFlag({
      goal: { event: 'order', kind: 'mean', windowHours: 72 },
      guardrails: ['refund', { event: 'latency', kind: 'mean', direction: 'decrease' }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().goal).toMatchObject({ event: 'order', kind: 'mean', windowHours: 72, capPercentile: 0.99 });
    expect(res.json().guardrails.map((g: { event: string }) => g.event)).toEqual(['refund', 'latency']);
  });
});

describe('evaluation and results', () => {
  it('records one exposure per user, and none on a dry run', async () => {
    await createFlag();
    await evaluateUser('u1');
    await evaluateUser('u1');
    await evaluateUser('u2', '?dryRun=true');
    const results = await get('/api/flags/checkout/results');
    expect(results.totalExposures).toBe(1);
  });

  it('only counts conversions that happen after exposure', async () => {
    await createFlag();
    const before = clock - 60_000;
    await track('u1', 'purchase', { timestamp: before });
    const { variant } = await evaluateUser('u1');

    let results = await get('/api/flags/checkout/results');
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(0);

    await post('/api/track', { events: [{ userId: 'u1', event: 'purchase' }] });
    results = await get('/api/flags/checkout/results');
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(1);
  });

  it('stores an event once when the same idempotency key is sent twice', async () => {
    await createFlag({ goal: { event: 'purchase', kind: 'mean' } });
    const { variant } = await evaluateUser('u1');
    const first = await track('u1', 'purchase', { value: 30, idempotencyKey: 'order-1' });
    const retry = await track('u1', 'purchase', { value: 30, idempotencyKey: 'order-1' });
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(retry.json()).toEqual({ accepted: 0, duplicates: 1 });

    const results = await get('/api/flags/checkout/results');
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).rate).toBe(30);
  });

  it('judges guardrails next to the goal', async () => {
    await createFlag({ guardrails: [{ event: 'refund', direction: 'decrease' }], dimensions: ['plan'] });
    const { variant } = await evaluateUser('u1', '', 'checkout', { attributes: { plan: 'pro', ignored: 'x' } });
    await track('u1', 'refund');

    const results = await get('/api/flags/checkout/results');
    expect(results.guardrails).toHaveLength(1);
    expect(results.guardrails[0].label).toBe('refund');
    expect(results.guardrails[0].variants.find((v: { variant: string }) => v.variant === variant).value).toBe(1);
    // Only the declared dimension is stored with the exposure.
    expect(Object.keys(results.segments)).toEqual(['plan']);
    expect(results.segments.plan[0]).toMatchObject({ value: 'pro', exposures: 1 });
  });
});

describe('identity', () => {
  it('joins a conversion made after login to the exposure made before it', async () => {
    await createFlag();
    const { variant, unitId } = await evaluateUser('anon-1');
    expect(unitId).toBe('anon-1');
    await track('account-9', 'purchase');

    let results = await get('/api/flags/checkout/results');
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(0);

    expect((await post('/api/identify', { anonymousId: 'anon-1', userId: 'account-9' })).statusCode).toBe(202);
    results = await get('/api/flags/checkout/results');
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(1);
  });

  it('keeps the variant stable across login when the anonymous id is passed along', async () => {
    await createFlag();
    const before = await evaluateUser('anon-2');
    const after = await evaluateUser('account-2', '', 'checkout', { anonymousId: 'anon-2' });
    expect(after.variant).toBe(before.variant);
    expect((await get('/api/flags/checkout/results')).totalExposures).toBe(1);
  });

  it('counts a user reported in two variants and leaves them out', async () => {
    await createFlag();
    const { variant } = await evaluateUser('u1');
    const other = variant === 'control' ? 'treatment' : 'control';
    const res = await post('/api/exposures', { exposures: [{ flagKey: 'checkout', userId: 'u1', variant: other, version: 1 }] });
    expect(res.json().accepted).toBe(1);

    const results = await get('/api/flags/checkout/results');
    expect(results.health.multipleExposures.count).toBe(1);
    expect(results.variants.every((v: { analyzed: number }) => v.analyzed === 0)).toBe(true);
  });
});

describe('timeseries', () => {
  it('returns cumulative exposures and lift that end at the current totals', async () => {
    await createFlag();
    for (let i = 0; i < 40; i++) await evaluateUser(`user-${i}`);
    await post('/api/track', { events: [{ userId: 'user-1', event: 'purchase' }] });

    const points = await get('/api/flags/checkout/timeseries');
    const results = await get('/api/flags/checkout/results');
    const last = points[points.length - 1];
    for (const v of results.variants) expect(last.exposures[v.variant]).toBe(v.exposures);
    expect(Object.keys(last.lift)).toEqual(['treatment']);
  });

  it('is empty before anyone is exposed', async () => {
    await createFlag();
    expect(await get('/api/flags/checkout/timeseries')).toEqual([]);
  });
});

describe('change guardrails', () => {
  beforeEach(async () => {
    await createFlag({ rolloutPercent: 50 });
    for (let i = 0; i < 50; i++) await evaluateUser(`user-${i}`);
  });

  it('allows safe changes like raising the rollout and records them in the audit log', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/flags/checkout', payload: { rolloutPercent: 80 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);

    const audit = await get('/api/flags/checkout/audit');
    expect(audit[0].summary).toBe('Rollout %: 50 → 80');
  });

  it('refuses unsafe changes to a running experiment', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/flags/checkout',
      payload: {
        variants: [
          { key: 'control', weight: 90 },
          { key: 'treatment', weight: 10 },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('UNSAFE_CHANGE');

    const lower = await app.inject({ method: 'PATCH', url: '/api/flags/checkout', payload: { rolloutPercent: 10 } });
    expect(lower.statusCode).toBe(409);
  });

  it('applies an unsafe change with force=true by starting a new phase, keeping the old data', async () => {
    const before = await get('/api/flags/checkout');
    const exposedBefore = (await get('/api/flags/checkout/results')).totalExposures;
    expect(exposedBefore).toBeGreaterThan(0);

    const res = await app.inject({ method: 'PATCH', url: '/api/flags/checkout?force=true', payload: { rolloutPercent: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().salt).not.toBe(before.salt);
    expect(res.json().phase).toBe(2);
    expect(res.json().phases.map((p: { number: number }) => p.number)).toEqual([1, 2]);

    expect((await get('/api/flags/checkout/results')).totalExposures).toBe(0);
    expect((await get('/api/flags/checkout/results?phase=1')).totalExposures).toBe(exposedBefore);
    expect((await app.inject({ method: 'GET', url: '/api/flags/checkout/results?phase=7' })).statusCode).toBe(404);
  });

  it('discards exposures that were assigned before a restart', async () => {
    await post('/api/flags/checkout/restart', { reason: 'Fixed the logging bug' });
    const stale = await post('/api/exposures', { exposures: [{ flagKey: 'checkout', userId: 'late', variant: 'control', version: 1, phase: 1 }] });
    expect(stale.json()).toMatchObject({ accepted: 0, rejected: 1 });
    const fresh = await post('/api/exposures', { exposures: [{ flagKey: 'checkout', userId: 'late', variant: 'control', version: 2, phase: 2 }] });
    expect(fresh.json()).toMatchObject({ accepted: 1, rejected: 0 });
  });
});

describe('lifecycle', () => {
  it('moves draft -> running -> rolled out -> archived, logging each step', async () => {
    const created = await createFlag({ enabled: false });
    expect(created.json()).toMatchObject({ status: 'draft', enabled: false });
    expect((await evaluateUser('u1')).reason).toBe('FLAG_DISABLED');

    const started = await post('/api/flags/checkout/start');
    expect(started.json()).toMatchObject({ status: 'running', enabled: true });
    expect(started.json().phases[0].startedAt).toBe(clock);
    expect((await post('/api/flags/checkout/start')).statusCode).toBe(400);

    expect((await post('/api/flags/checkout/rollout', { variant: 'nope' })).statusCode).toBe(400);
    const shipped = await post('/api/flags/checkout/rollout', { variant: 'treatment' });
    expect(shipped.json()).toMatchObject({ status: 'rolled_out', rolledOutVariant: 'treatment', enabled: true });
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(await evaluateUser(id)).toMatchObject({ variant: 'treatment', reason: 'ROLLED_OUT', inExperiment: false });
    }
    expect((await get('/api/flags/checkout/results')).totalExposures).toBe(0);

    const archived = await app.inject({ method: 'DELETE', url: '/api/flags/checkout' });
    expect(archived.json().status).toBe('archived');
    expect(await get('/api/flags')).toEqual([]);
    expect(await get('/api/flags?archived=true')).toHaveLength(1);
    expect((await get('/api/sdk/config')).flags).toEqual([]);

    const audit = (await get('/api/flags/checkout/audit')).map((a: { summary: string }) => a.summary);
    expect(audit).toEqual(['Archived', 'Rolled out treatment to everyone', 'Experiment started', 'Flag created']);
  });

  it('will not archive a running experiment', async () => {
    await createFlag();
    expect((await app.inject({ method: 'DELETE', url: '/api/flags/checkout' })).statusCode).toBe(400);
  });

  it('treats the enabled switch as start and stop', async () => {
    await createFlag({ enabled: false });
    const on = await app.inject({ method: 'PATCH', url: '/api/flags/checkout', payload: { enabled: true } });
    expect(on.json().status).toBe('running');
    const off = await app.inject({ method: 'PATCH', url: '/api/flags/checkout', payload: { enabled: false } });
    expect(off.json()).toMatchObject({ status: 'stopped', enabled: false });
  });

  it('flags a shipped experiment whose flag is still around weeks later', async () => {
    await createFlag();
    await post('/api/flags/checkout/rollout', { variant: 'treatment' });
    expect((await get('/api/flags'))[0].summary.cleanup).toBeNull();
    clock += 20 * DAY;
    expect((await get('/api/flags'))[0].summary.cleanup).toMatch(/Rolled out 20 days ago/);
  });
});

describe('sample plan', () => {
  it('locks the plan from a stated baseline and stops it moving with the data', async () => {
    await createFlag({ expectedBaseline: 0.1 });
    await evaluateUser('u1');
    const first = await get('/api/flags/checkout/results');
    expect(first.planSource).toBe('locked');
    expect(Math.abs(first.requiredPerVariant - 14_751)).toBeLessThanOrEqual(2);

    const flag = await get('/api/flags/checkout');
    expect(flag.plan).toMatchObject({ source: 'stated', baseline: 0.1, requiredPerVariant: first.requiredPerVariant });
    expect((await get('/api/flags/checkout/audit'))[0].summary).toMatch(/^Sample plan locked: /);

    // Everyone converts: the observed baseline is nowhere near 10%, and the target does not budge.
    for (let i = 0; i < 150; i++) {
      await evaluateUser(`user-${i}`);
      await track(`user-${i}`, 'purchase');
    }
    expect((await get('/api/flags/checkout/results')).requiredPerVariant).toBe(first.requiredPerVariant);
  });

  it('plans again when the minimum detectable effect changes', async () => {
    await createFlag({ expectedBaseline: 0.1 });
    const before = (await get('/api/flags/checkout/results')).requiredPerVariant;
    await app.inject({ method: 'PATCH', url: '/api/flags/checkout', payload: { minDetectableEffect: 0.05 } });
    expect((await get('/api/flags/checkout/results')).requiredPerVariant).toBeGreaterThan(before * 3);
  });
});

describe('mutual exclusion', () => {
  it('refuses two experiments that claim the same users in one group', async () => {
    expect((await createFlag({ exclusion: { group: 'cart', start: 0, end: 60 } })).statusCode).toBe(201);
    const overlapping = await createFlag({ key: 'cart-copy', exclusion: { group: 'cart', start: 50, end: 100 } });
    expect(overlapping.statusCode).toBe(400);
    expect(overlapping.json().message).toMatch(/overlaps "checkout"/);
    expect((await createFlag({ key: 'cart-copy', exclusion: { group: 'cart', start: 60, end: 100 } })).statusCode).toBe(201);

    for (let i = 0; i < 300; i++) {
      const a = await evaluateUser(`user-${i}`, '?dryRun=true');
      const b = await evaluateUser(`user-${i}`, '?dryRun=true', 'cart-copy');
      expect(a.inExperiment && b.inExperiment).toBe(false);
    }
  });
});

describe('holdouts', () => {
  it('holds users back, logs membership, and reads the cumulative effect', async () => {
    const created = await post('/api/holdouts', { key: 'h2026', percent: 20, metric: 'purchase' });
    expect(created.statusCode).toBe(201);
    expect((await createFlag({ holdout: 'missing' })).statusCode).toBe(400);
    const flag = await createFlag({ holdout: 'h2026' });
    expect(flag.json().holdout).toEqual({ key: 'h2026', percent: 20 });

    let held = 0;
    for (let i = 0; i < 400; i++) {
      const result = await evaluateUser(`user-${i}`);
      if (result.reason === 'HOLDOUT') {
        held++;
        expect(result).toMatchObject({ variant: 'control', inExperiment: false });
      } else {
        await track(`user-${i}`, 'purchase');
      }
    }
    expect(held).toBeGreaterThan(40);
    expect(held).toBeLessThan(120);

    const readout = await get('/api/holdouts/h2026');
    expect(readout.flags).toEqual(['checkout']);
    const [holdout, exposed] = readout.report.variants;
    expect(holdout).toMatchObject({ variant: 'holdout', exposures: held, rate: 0 });
    expect(exposed).toMatchObject({ variant: 'exposed', exposures: 400 - held, rate: 1 });
    expect((await get('/api/holdouts'))[0].holdout.key).toBe('h2026');
    // Held-out users never enter the experiment itself.
    expect((await get('/api/flags/checkout/results')).totalExposures).toBe(400 - held);
  });
});

describe('SDK keys and environments', () => {
  it('requires a key once one exists, and keeps staging traffic out of the analysis', async () => {
    await createFlag({ key: 'live' });
    await createFlag({ key: 'in-qa', enabled: false, environments: ['staging'] });
    expect((await app.inject({ method: 'GET', url: '/api/sdk/config' })).statusCode).toBe(200);

    const production = (await post('/api/sdk-keys', { environment: 'production' })).json().key as string;
    const staging = (await post('/api/sdk-keys', { environment: 'staging' })).json().key as string;

    expect((await app.inject({ method: 'GET', url: '/api/sdk/config' })).statusCode).toBe(401);
    expect((await post('/api/track', { userId: 'u', event: 'purchase' })).statusCode).toBe(401);
    expect((await post('/api/evaluate?dryRun=true', { flagKey: 'live', user: { id: 'u' } })).statusCode).toBe(200);

    const config = async (key: string) => (await app.inject({ method: 'GET', url: '/api/sdk/config', headers: { 'x-sdk-key': key } })).json();
    const enabledIn = (c: { flags: Array<{ key: string; enabled: boolean }> }) => Object.fromEntries(c.flags.map((f) => [f.key, f.enabled]));
    expect(enabledIn(await config(production))).toEqual({ live: true, 'in-qa': false });
    expect(enabledIn(await config(staging))).toEqual({ live: false, 'in-qa': true });
    // The SDK payload carries what evaluation needs and nothing about the analysis.
    expect((await config(production)).flags[0]).not.toHaveProperty('goal');
    expect((await config(production)).flags[0]).not.toHaveProperty('description');

    const fromStaging = await post('/api/exposures', { exposures: [{ flagKey: 'in-qa', userId: 'qa', variant: 'control', version: 1 }] }, { 'x-sdk-key': staging });
    expect(fromStaging.json()).toEqual({ accepted: 0, rejected: 0, ignored: 1 });
    const fromProduction = await post('/api/exposures', { exposures: [{ flagKey: 'live', userId: 'u', variant: 'control', version: 1 }] }, { 'x-sdk-key': production });
    expect(fromProduction.json()).toEqual({ accepted: 1, rejected: 0, ignored: 0 });
    expect((await get('/api/flags/in-qa/results')).totalExposures).toBe(0);

    expect((await app.inject({ method: 'DELETE', url: `/api/sdk-keys/${staging}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sdk/config', headers: { 'x-sdk-key': staging } })).statusCode).toBe(401);
  });
});

describe('admin token', () => {
  it('protects flag mutations but not evaluation', async () => {
    await app.close();
    app = buildApp({ adminToken: 'secret' });

    expect((await createFlag()).statusCode).toBe(401);
    const created = await app.inject({
      method: 'POST',
      url: '/api/flags',
      headers: { authorization: 'Bearer secret' },
      payload: { key: 'checkout', enabled: true },
    });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/flags' })).statusCode).toBe(200);
    expect((await evaluateUser('u1')).variant).toBeDefined();
  });

  it('protects lifecycle changes, holdouts and SDK keys', async () => {
    await app.close();
    app = buildApp({ adminToken: 'secret' });
    const auth = { authorization: 'Bearer secret' };
    await post('/api/flags', { key: 'checkout', enabled: true }, auth);

    expect((await post('/api/flags/checkout/stop')).statusCode).toBe(401);
    expect((await post('/api/holdouts', { key: 'h1', percent: 5, metric: 'purchase' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sdk-keys' })).statusCode).toBe(401);
    expect((await post('/api/flags/checkout/stop', undefined, auth)).json().status).toBe('stopped');
    expect((await app.inject({ method: 'GET', url: '/api/sdk-keys', headers: auth })).json()).toEqual([]);
  });
});
