import { OpenFeature } from '@openfeature/server-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerdictClient } from '../src/sdk/index.js';
import { VerdictProvider } from '../src/sdk/openfeature.js';
import { buildApp } from '../src/server/app.js';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildApp();
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  await app.inject({ method: 'POST', url: '/api/flags', payload: { key: 'new-nav', enabled: true, primaryMetric: 'signup', dimensions: ['plan'] } });
  await app.inject({
    method: 'POST',
    url: '/api/flags',
    payload: {
      key: 'page-size',
      enabled: true,
      variants: [
        { key: 'small', weight: 50, value: 20 },
        { key: 'large', weight: 50, value: 50 },
      ],
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/flags',
    payload: {
      key: 'dark-mode',
      enabled: true,
      variants: [
        { key: 'off', weight: 50, value: false },
        { key: 'on', weight: 50, value: true },
      ],
    },
  });
});

afterAll(async () => {
  await OpenFeature.close();
  await app.close();
});

const results = async (key: string) => (await app.inject({ method: 'GET', url: `/api/flags/${key}/results` })).json();

describe('VerdictClient', () => {
  it('evaluates locally with the same result as the server', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();

    for (let i = 0; i < 25; i++) {
      const user = { id: `sdk-user-${i}` };
      const server = await app.inject({ method: 'POST', url: '/api/evaluate?dryRun=true', payload: { flagKey: 'new-nav', user } });
      expect(client.variant('new-nav', user)).toBe(server.json().variant);
    }
  });

  it('batches exposures and events to the server', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();

    const variant = client.variant('new-nav', { id: 'buyer', attributes: { plan: 'pro' } });
    client.variant('new-nav', { id: 'buyer' }); // deduplicated
    client.track('buyer', 'signup');
    await client.flush();

    const report = await results('new-nav');
    const arm = report.variants.find((v: { variant: string }) => v.variant === variant);
    expect(arm.exposures).toBeGreaterThanOrEqual(1);
    expect(arm.conversions).toBe(1);
    // The declared dimension travelled with the exposure.
    expect(report.segments.plan.some((s: { value: string }) => s.value === 'pro')).toBe(true);
  });

  it('falls back safely for unknown flags', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();
    expect(client.variant('does-not-exist', { id: 'u' }, 'off')).toBe('off');
  });

  it('reads variant payloads', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();
    const user = { id: 'payload-user' };
    expect(client.value('page-size', user, 10)).toBe(client.variant('page-size', user) === 'small' ? 20 : 50);
    expect(client.value('new-nav', user, 'fallback')).toBe('fallback');
  });

  it('keeps one variant across login and links the two ids', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();
    const before = client.variant('new-nav', { id: 'device-7' });
    const after = client.variant('new-nav', { id: 'member-7', anonymousId: 'device-7' });
    expect(after).toBe(before);

    client.track('member-7', 'signup'); // tracked under the account id
    await client.flush();
    const arm = (await results('new-nav')).variants.find((v: { variant: string }) => v.variant === before);
    expect(arm.conversions).toBeGreaterThanOrEqual(1);
    expect((await results('new-nav')).health.multipleExposures.count).toBe(0);
  });

  it('keeps what it could not send and never double-counts on retry', async () => {
    let failTracking = true;
    const flaky: typeof fetch = async (input, init) => {
      if (failTracking && String(input).endsWith('/api/track')) return new Response('{}', { status: 503 });
      return fetch(input, init);
    };
    const client = new VerdictClient({ baseUrl, fetch: flaky });
    await client.refresh();

    const variant = client.variant('new-nav', { id: 'retry-user' });
    client.track('retry-user', 'signup');
    const before = (await results('new-nav')).variants.find((v: { variant: string }) => v.variant === variant).conversions;

    await expect(client.flush()).rejects.toThrow(/503/);
    failTracking = false;
    await client.flush();
    await client.flush(); // nothing left to send

    const after = (await results('new-nav')).variants.find((v: { variant: string }) => v.variant === variant).conversions;
    expect(after).toBe(before + 1);
  });
});

describe('OpenFeature provider', () => {
  it('serves Verdict flags through the standard OpenFeature client', async () => {
    const verdict = new VerdictClient({ baseUrl });
    await OpenFeature.setProviderAndWait(new VerdictProvider(verdict));
    const client = OpenFeature.getClient();
    const context = { targetingKey: 'of-user-1', plan: 'pro' };

    const nav = await client.getStringDetails('new-nav', 'fallback', context);
    expect(nav.value).toBe(verdict.variant('new-nav', { id: 'of-user-1' }));
    expect(nav.variant).toBe(nav.value);
    expect(nav.reason).toBe('SPLIT');

    expect(await client.getNumberValue('page-size', 10, context)).toBe(verdict.value('page-size', { id: 'of-user-1' }, 10));
    expect(await client.getBooleanValue('dark-mode', false, context)).toBe(verdict.variant('dark-mode', { id: 'of-user-1' }) === 'on');
    // Without a boolean payload, any variant other than the control reads as "on".
    expect(await client.getBooleanValue('new-nav', false, context)).toBe(nav.value !== 'control');
  });

  it('falls back to the default with a standard error code', async () => {
    const client = OpenFeature.getClient();
    const missing = await client.getStringDetails('nope', 'fallback', { targetingKey: 'u' });
    expect(missing).toMatchObject({ value: 'fallback', errorCode: 'FLAG_NOT_FOUND' });
    const anonymous = await client.getStringDetails('new-nav', 'fallback', {});
    expect(anonymous).toMatchObject({ value: 'fallback', errorCode: 'TARGETING_KEY_MISSING' });
    const wrongType = await client.getNumberDetails('new-nav', 7, { targetingKey: 'u' });
    expect(wrongType).toMatchObject({ value: 7, errorCode: 'TYPE_MISMATCH' });
  });
});
