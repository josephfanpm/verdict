import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerdictClient } from '../src/sdk/index.js';
import { buildApp } from '../src/server/app.js';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildApp();
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  await app.inject({ method: 'POST', url: '/api/flags', payload: { key: 'new-nav', enabled: true, primaryMetric: 'signup' } });
});

afterAll(async () => {
  await app.close();
});

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

    const variant = client.variant('new-nav', { id: 'buyer' });
    client.variant('new-nav', { id: 'buyer' }); // deduplicated
    client.track('buyer', 'signup');
    await client.flush();

    const results = (await app.inject({ method: 'GET', url: '/api/flags/new-nav/results' })).json();
    const arm = results.variants.find((v: { variant: string }) => v.variant === variant);
    expect(arm.exposures).toBeGreaterThanOrEqual(1);
    expect(arm.conversions).toBe(1);
  });

  it('falls back safely for unknown flags', async () => {
    const client = new VerdictClient({ baseUrl });
    await client.refresh();
    expect(client.variant('does-not-exist', { id: 'u' }, 'off')).toBe('off');
  });
});
