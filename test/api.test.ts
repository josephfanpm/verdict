import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp();
});

afterEach(async () => {
  await app.close();
});

async function createFlag(body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/flags', payload: { key: 'checkout', enabled: true, primaryMetric: 'purchase', ...body } });
}

async function evaluateUser(userId: string, query = '') {
  const res = await app.inject({ method: 'POST', url: `/api/evaluate${query}`, payload: { flagKey: 'checkout', user: { id: userId } } });
  return res.json();
}

describe('flags API', () => {
  it('creates a flag with sensible defaults', async () => {
    const res = await createFlag();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      key: 'checkout',
      version: 1,
      defaultVariant: 'control',
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
});

describe('evaluation and results', () => {
  it('records one exposure per user, and none on a dry run', async () => {
    await createFlag();
    await evaluateUser('u1');
    await evaluateUser('u1');
    await evaluateUser('u2', '?dryRun=true');
    const results = (await app.inject({ method: 'GET', url: '/api/flags/checkout/results' })).json();
    expect(results.totalExposures).toBe(1);
  });

  it('only counts conversions that happen after exposure', async () => {
    await createFlag();
    const before = Date.now() - 60_000;
    await app.inject({ method: 'POST', url: '/api/track', payload: { userId: 'u1', event: 'purchase', timestamp: before } });
    const { variant } = await evaluateUser('u1');

    let results = (await app.inject({ method: 'GET', url: '/api/flags/checkout/results' })).json();
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(0);

    await app.inject({ method: 'POST', url: '/api/track', payload: { events: [{ userId: 'u1', event: 'purchase' }] } });
    results = (await app.inject({ method: 'GET', url: '/api/flags/checkout/results' })).json();
    expect(results.variants.find((v: { variant: string }) => v.variant === variant).conversions).toBe(1);
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

    const audit = (await app.inject({ method: 'GET', url: '/api/flags/checkout/audit' })).json();
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

  it('applies an unsafe change with force=true by restarting the experiment', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/flags/checkout' })).json();
    const res = await app.inject({ method: 'PATCH', url: '/api/flags/checkout?force=true', payload: { rolloutPercent: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().salt).not.toBe(before.salt);

    const results = (await app.inject({ method: 'GET', url: '/api/flags/checkout/results' })).json();
    expect(results.totalExposures).toBe(0);
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
});
