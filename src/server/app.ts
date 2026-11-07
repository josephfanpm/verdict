import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { analyze } from '../core/analyze.js';
import { evaluate, validateFlag } from '../core/evaluate.js';
import { timeseries } from '../core/timeseries.js';
import type { FlagConfig } from '../core/types.js';
import { Store } from './store.js';

export interface AppOptions {
  store?: Store;
  /** When set, flag mutations require `Authorization: Bearer <token>`. */
  adminToken?: string;
  /** Directory of the built dashboard to serve at `/`. */
  staticDir?: string;
  logger?: boolean;
}

// --- request schemas ---------------------------------------------------------

const condition = z.object({
  attribute: z.string().min(1),
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'contains', 'gt', 'lt']),
  values: z.array(z.union([z.string(), z.number()])).min(1),
});

const variant = z.object({ key: z.string().min(1).max(64), weight: z.number() });

const editableFields = {
  description: z.string().max(500),
  enabled: z.boolean(),
  rolloutPercent: z.number().min(0).max(100),
  variants: z.array(variant).min(2).max(10),
  defaultVariant: z.string(),
  targeting: z.array(condition).max(20),
  primaryMetric: z.string().min(1).max(64),
  minDetectableEffect: z.number().positive(),
};

const createFlagBody = z.object({
  key: z.string(),
  description: editableFields.description.default(''),
  enabled: editableFields.enabled.default(false),
  rolloutPercent: editableFields.rolloutPercent.default(100),
  variants: editableFields.variants.default([
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ]),
  defaultVariant: editableFields.defaultVariant.optional(),
  targeting: editableFields.targeting.default([]),
  primaryMetric: editableFields.primaryMetric.default('conversion'),
  minDetectableEffect: editableFields.minDetectableEffect.default(0.1),
});

const patchFlagBody = z.object(editableFields).partial().strict();

const user = z.object({
  id: z.string().min(1).max(256),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const evaluateBody = z.object({ flagKey: z.string(), user });

const exposuresBody = z.object({
  exposures: z
    .array(
      z.object({
        flagKey: z.string(),
        userId: z.string().min(1).max(256),
        variant: z.string(),
        version: z.number().int(),
        timestamp: z.number().int().optional(),
      })
    )
    .max(1000),
});

const trackEvent = z.object({
  userId: z.string().min(1).max(256),
  event: z.string().min(1).max(64),
  value: z.number().optional(),
  timestamp: z.number().int().optional(),
});
const trackBody = z.union([trackEvent, z.object({ events: z.array(trackEvent).max(1000) })]);

// --- app -----------------------------------------------------------------------

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const store = options.store ?? new Store();
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onClose', async () => store.close());

  app.addHook('onRequest', async (request, reply) => {
    const isMutation = request.method !== 'GET' && request.url.startsWith('/api/flags');
    if (!isMutation || !options.adminToken) return;
    if (request.headers.authorization !== `Bearer ${options.adminToken}`) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'A valid admin token is required to change flags.' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Flags ----------------------------------------------------------------------

  app.get('/api/flags', async () =>
    store.listFlags().map((flag) => {
      const report = analyze(flag, store.variantCounts(flag.key, flag.primaryMetric));
      return {
        flag,
        summary: {
          verdict: report.verdict.kind,
          headline: report.verdict.headline,
          totalExposures: report.totalExposures,
          progress: report.progress,
        },
      };
    })
  );

  app.post('/api/flags', async (request, reply) => {
    const body = parse(createFlagBody, request.body, reply);
    if (!body) return;
    if (store.getFlag(body.key)) {
      return reply.code(409).send({ error: 'FLAG_EXISTS', message: `A flag named "${body.key}" already exists.` });
    }

    const flag: FlagConfig = {
      ...body,
      defaultVariant: body.defaultVariant ?? body.variants[0]!.key,
      salt: newSalt(),
      version: 1,
    };
    const errors = validateFlag(flag);
    if (errors.length) return reply.code(400).send({ error: 'INVALID_FLAG', message: errors.join(' '), issues: errors });

    store.transaction(() => {
      store.insertFlag(flag);
      store.addAudit(flag.key, flag.version, 'Flag created');
    });
    return reply.code(201).send(flag);
  });

  app.get<{ Params: { key: string } }>('/api/flags/:key', async (request, reply) => {
    const flag = store.getFlag(request.params.key);
    return flag ?? notFound(reply, request.params.key);
  });

  app.patch<{ Params: { key: string }; Querystring: { force?: string } }>('/api/flags/:key', async (request, reply) => {
    const current = store.getFlag(request.params.key);
    if (!current) return notFound(reply, request.params.key);
    const patch = parse(patchFlagBody, request.body, reply);
    if (!patch) return;

    const next: FlagConfig = { ...current, ...patch, version: current.version + 1 };
    const errors = validateFlag(next);
    if (errors.length) return reply.code(400).send({ error: 'INVALID_FLAG', message: errors.join(' '), issues: errors });

    const changes = describeChanges(current, next);
    if (changes.length === 0) return current;

    // Guardrail: some edits silently corrupt a running experiment. Refuse them
    // unless the caller explicitly accepts restarting it.
    const exposures = store.exposureCount(current.key);
    const risks = exposures > 0 ? unsafeChanges(current, next) : [];
    const force = request.query.force === 'true';
    if (risks.length && !force) {
      return reply.code(409).send({
        error: 'UNSAFE_CHANGE',
        message: `This experiment already has ${exposures.toLocaleString('en-US')} exposures. ${risks.join(' ')} Re-send with ?force=true to apply it and restart the experiment.`,
        issues: risks,
      });
    }

    store.transaction(() => {
      if (risks.length) {
        next.salt = newSalt();
        const discarded = store.clearExposures(current.key);
        changes.push(`Experiment restarted with a new salt (${discarded.toLocaleString('en-US')} exposures discarded)`);
      }
      store.updateFlag(next);
      store.addAudit(next.key, next.version, changes.join('; '));
    });
    return next;
  });

  app.get<{ Params: { key: string } }>('/api/flags/:key/results', async (request, reply) => {
    const flag = store.getFlag(request.params.key);
    if (!flag) return notFound(reply, request.params.key);
    return analyze(flag, store.variantCounts(flag.key, flag.primaryMetric));
  });

  app.get<{ Params: { key: string } }>('/api/flags/:key/timeseries', async (request, reply) => {
    const flag = store.getFlag(request.params.key);
    if (!flag) return notFound(reply, request.params.key);
    const { alpha } = analyze(flag, []);
    return timeseries(flag, store.exposureRows(flag.key, flag.primaryMetric), alpha);
  });

  app.get<{ Params: { key: string } }>('/api/flags/:key/audit', async (request, reply) => {
    if (!store.getFlag(request.params.key)) return notFound(reply, request.params.key);
    return store.auditLog(request.params.key);
  });

  // Evaluation & ingestion -------------------------------------------------------

  /** Everything an SDK needs to evaluate flags locally, with no network call per check. */
  app.get('/api/sdk/config', async () => ({ flags: store.listFlags(), generatedAt: Date.now() }));

  app.post<{ Querystring: { dryRun?: string } }>('/api/evaluate', async (request, reply) => {
    const body = parse(evaluateBody, request.body, reply);
    if (!body) return;
    const flag = store.getFlag(body.flagKey);
    if (!flag) return notFound(reply, body.flagKey);

    const result = evaluate(flag, body.user);
    if (result.inExperiment && request.query.dryRun !== 'true') {
      store.recordExposure(flag.key, body.user.id, result.variant, flag.version);
    }
    return result;
  });

  app.post('/api/exposures', async (request, reply) => {
    const body = parse(exposuresBody, request.body, reply);
    if (!body) return;
    let accepted = 0;
    let rejected = 0;
    store.transaction(() => {
      for (const e of body.exposures) {
        const flag = store.getFlag(e.flagKey);
        if (!flag || !flag.variants.some((v) => v.key === e.variant)) {
          rejected++;
          continue;
        }
        store.recordExposure(e.flagKey, e.userId, e.variant, e.version, e.timestamp ?? Date.now());
        accepted++;
      }
    });
    return { accepted, rejected };
  });

  app.post('/api/track', async (request, reply) => {
    const body = parse(trackBody, request.body, reply);
    if (!body) return;
    const events = 'events' in body ? body.events : [body];
    store.transaction(() => {
      for (const e of events) store.recordEvent(e.userId, e.event, e.value ?? null, e.timestamp ?? Date.now());
    });
    return reply.code(202).send({ accepted: events.length });
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.register(fastifyStatic, { root: options.staticDir });
  }

  return app;
}

// --- helpers -------------------------------------------------------------------

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, reply: FastifyReply): z.output<S> | undefined {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  const issues = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
  reply.code(400).send({ error: 'INVALID_REQUEST', message: issues.join('; '), issues });
  return undefined;
}

function notFound(reply: FastifyReply, key: string) {
  return reply.code(404).send({ error: 'NOT_FOUND', message: `No flag named "${key}".` });
}

function newSalt(): string {
  return randomBytes(6).toString('hex');
}

const FIELD_LABELS: Partial<Record<keyof FlagConfig, string>> = {
  description: 'Description',
  enabled: 'Enabled',
  rolloutPercent: 'Rollout %',
  variants: 'Variants',
  defaultVariant: 'Default variant',
  targeting: 'Targeting',
  primaryMetric: 'Primary metric',
  minDetectableEffect: 'Minimum detectable effect',
};

function describeChanges(before: FlagConfig, after: FlagConfig): string[] {
  return (Object.keys(FIELD_LABELS) as Array<keyof FlagConfig>)
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => `${FIELD_LABELS[f]}: ${short(before[f])} → ${short(after[f])}`);
}

function short(value: unknown): string {
  if (Array.isArray(value) && value.every((v) => typeof v === 'object' && v && 'key' in v && 'weight' in v)) {
    return (value as Array<{ key: string; weight: number }>).map((v) => `${v.key} ${v.weight}%`).join(' / ');
  }
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Changes that would bias an experiment that already has exposures. Raising
 * the rollout is safe (bucketing only adds users); these are not.
 */
function unsafeChanges(before: FlagConfig, after: FlagConfig): string[] {
  const risks: string[] = [];
  if (JSON.stringify(before.variants) !== JSON.stringify(after.variants)) {
    risks.push('Changing variants or weights mid-test moves users between arms and causes a sample ratio mismatch.');
  }
  if (after.rolloutPercent < before.rolloutPercent) {
    risks.push('Lowering the rollout drops users who were already exposed, which biases the comparison.');
  }
  if (JSON.stringify(before.targeting) !== JSON.stringify(after.targeting)) {
    risks.push('Changing targeting mid-test changes who is in the experiment.');
  }
  return risks;
}
