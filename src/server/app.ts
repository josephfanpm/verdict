import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildInput, capFor, collect, type AnalysisInput, type Collected } from '../core/aggregate.js';
import { analyze, planToLock, type ExperimentReport } from '../core/analyze.js';
import { evaluate, exposureAttributes, validateFlag } from '../core/evaluate.js';
import { metric, metricLabel, normalizeFlag } from '../core/flag.js';
import { timeseries } from '../core/timeseries.js';
import type { EvaluableFlag, FlagConfig, FlagStatus, MetricDef, SamplePlan } from '../core/types.js';
import { HOLDOUT_PREFIX, HOLDOUT_VARIANTS, Store, type Holdout } from './store.js';

export interface AppOptions {
  store?: Store;
  /** When set, flag, holdout and SDK-key changes require `Authorization: Bearer <token>`. */
  adminToken?: string;
  /** Directory of the built dashboard to serve at `/`. */
  staticDir?: string;
  logger?: boolean;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const DAY = 86_400_000;
/** A stopped or rolled-out flag still in code after this long is flagged for cleanup. */
const STALE_AFTER_DAYS = 14;
const PRODUCTION = 'production';

// --- request schemas ---------------------------------------------------------

const condition = z.object({
  attribute: z.string().min(1),
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'contains', 'gt', 'lt']),
  values: z.array(z.union([z.string(), z.number()])).min(1),
});

const variant = z.object({
  key: z.string().min(1).max(64),
  weight: z.number(),
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]).optional(),
});

const eventName = z.string().min(1).max(64);
const metricInput = z.union([
  eventName,
  z.object({
    event: eventName,
    kind: z.enum(['conversion', 'mean', 'ratio']).optional(),
    direction: z.enum(['increase', 'decrease']).optional(),
    windowHours: z.number().positive().nullable().optional(),
    denominatorEvent: eventName.nullable().optional(),
    capPercentile: z.number().nullable().optional(),
  }),
]);

const editableFields = {
  description: z.string().max(500),
  enabled: z.boolean(),
  rolloutPercent: z.number().min(0).max(100),
  variants: z.array(variant).min(2).max(10),
  defaultVariant: z.string(),
  targeting: z.array(condition).max(20),
  /** Shorthand for a conversion goal on this event. */
  primaryMetric: eventName,
  goal: metricInput,
  guardrails: z.array(metricInput).max(10),
  minDetectableEffect: z.number().positive(),
  minRuntimeDays: z.number().min(0).max(90),
  sequential: z.boolean(),
  cuped: z.boolean(),
  preExperimentDays: z.number().int().min(1).max(90),
  expectedBaseline: z.number().positive().nullable(),
  expectedBaselineSd: z.number().positive().nullable(),
  overrides: z.array(z.object({ conditions: z.array(condition).min(1).max(10), variant: z.string() })).max(20),
  exclusion: z.object({ group: z.string().min(1).max(64), start: z.number(), end: z.number() }).nullable(),
  /** Key of an existing holdout, or null to leave it. */
  holdout: z.string().nullable(),
  environments: z.array(z.string().min(1).max(32)).max(10),
  dimensions: z.array(z.string().min(1).max(64)).max(5),
};

const createFlagBody = z.object(editableFields).partial().extend({ key: z.string() });
const patchFlagBody = z.object(editableFields).partial().strict();
type FlagBody = z.infer<typeof patchFlagBody>;

const user = z.object({
  id: z.string().min(1).max(256),
  anonymousId: z.string().min(1).max(256).optional(),
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
        phase: z.number().int().optional(),
        timestamp: z.number().int().optional(),
        attributes: z.record(z.string().max(256)).optional(),
      })
    )
    .max(1000),
});

const trackEvent = z.object({
  userId: z.string().min(1).max(256),
  event: eventName,
  value: z.number().optional(),
  timestamp: z.number().int().optional(),
  /** Sending the same key twice stores the event once, so a retried request cannot double-count. */
  idempotencyKey: z.string().min(1).max(128).optional(),
});
const trackBody = z.union([trackEvent, z.object({ events: z.array(trackEvent).max(1000) })]);

const identifyBody = z.object({ anonymousId: z.string().min(1).max(256), userId: z.string().min(1).max(256) });
const rolloutBody = z.object({ variant: z.string() });
const restartBody = z.object({ reason: z.string().max(200).optional() });
const sdkKeyBody = z.object({ environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Use lowercase letters, numbers and dashes.') });
const holdoutBody = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-_]{1,62}$/, 'Use 2-63 lowercase letters, numbers, dashes or underscores.'),
  description: z.string().max(500).default(''),
  percent: z.number().gt(0).lt(50),
  metric: metricInput,
});

// --- app -----------------------------------------------------------------------

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const store = options.store ?? new Store();
  const now = options.now ?? Date.now;
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onClose', async () => store.close());

  app.addHook('onRequest', async (request, reply) => {
    if (!options.adminToken) return;
    const path = request.url.split('?')[0]!;
    const mutation = request.method !== 'GET' && (path.startsWith('/api/flags') || path.startsWith('/api/holdouts'));
    // SDK keys are secrets, so listing them needs the token too.
    if (!mutation && !path.startsWith('/api/sdk-keys')) return;
    if (request.headers.authorization !== `Bearer ${options.adminToken}`) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'A valid admin token is required for this.' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  // --- analysis ----------------------------------------------------------------

  interface Analysis {
    flag: FlagConfig;
    collected: Collected;
    report: ExperimentReport;
  }
  const cache = new Map<string, { revision: number; value: Analysis }>();

  /** Read a phase's data and run the decision engine. Results are reused until something is written. */
  function analyzePhase(flag: FlagConfig, phaseNumber = flag.phase): Analysis {
    const cacheKey = `${flag.key}:${phaseNumber}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.revision === store.revision) return hit.value;

    const current = phaseNumber === flag.phase;
    const read = readPhase(store, flag, phaseNumber, now());
    const { collected, input } = read;
    let view = read.flag;

    // Lock the sample plan the first time one can be made, so the finish line never moves afterwards.
    const lock = current ? planToLock(view, input.goal[0] ?? null, now()) : null;
    if (lock) {
      view = { ...view, plan: lock };
      store.transaction(() => {
        store.updateFlag(view);
        store.addAudit(view.key, view.version, describePlan(view, lock));
      });
    }

    const value = { flag: view, collected, report: analyze(view, input) };
    cache.set(cacheKey, { revision: store.revision, value });
    return value;
  }

  function summarize(flag: FlagConfig) {
    const { flag: latest, report } = analyzePhase(flag);
    const idleDays = latest.statusChangedAt === null ? 0 : (now() - latest.statusChangedAt) / DAY;
    const stale = (latest.status === 'rolled_out' || latest.status === 'stopped') && idleDays > STALE_AFTER_DAYS;
    return {
      flag: latest,
      summary: {
        verdict: report.verdict.kind,
        headline: report.verdict.headline,
        totalExposures: report.totalExposures,
        progress: report.progress,
        /** Set when the decision is made but the flag is still in code. */
        cleanup: stale
          ? latest.status === 'rolled_out'
            ? `Rolled out ${Math.floor(idleDays)} days ago. Remove the flag from code, then archive it.`
            : `Stopped ${Math.floor(idleDays)} days ago. Remove the flag from code, then archive it.`
          : null,
      },
    };
  }

  // --- flags -------------------------------------------------------------------

  app.get<{ Querystring: { archived?: string } }>('/api/flags', async (request) => store.listFlags(request.query.archived === 'true').map(summarize));

  app.post('/api/flags', async (request, reply) => {
    const body = parse(createFlagBody, request.body, reply);
    if (!body) return;
    if (store.getFlag(body.key)) {
      return reply.code(409).send({ error: 'FLAG_EXISTS', message: `A flag named "${body.key}" already exists.` });
    }

    const built = applyBody(normalizeFlag({ key: body.key, salt: newSalt(), variants: body.variants }), body);
    if (typeof built === 'string') return reply.code(400).send({ error: 'INVALID_FLAG', message: built, issues: [built] });
    let flag = built;
    if (body.defaultVariant === undefined) flag.defaultVariant = flag.variants[0]!.key;
    if (body.enabled) flag = start(flag, now());

    const errors = [...validateFlag(flag), ...exclusionConflicts(flag)];
    if (errors.length) return reply.code(400).send({ error: 'INVALID_FLAG', message: errors.join(' '), issues: errors });

    store.transaction(() => {
      store.insertFlag(flag, now());
      store.addAudit(flag.key, flag.version, body.enabled ? 'Flag created and started' : 'Flag created');
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

    const built = applyBody(current, patch);
    if (typeof built === 'string') return reply.code(400).send({ error: 'INVALID_FLAG', message: built, issues: [built] });
    let next: FlagConfig = { ...built, version: current.version + 1 };
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      next = patch.enabled ? start(next, now()) : setStatus(next, current.status === 'draft' ? 'draft' : 'stopped', now());
    }

    const errors = [...validateFlag(next), ...exclusionConflicts(next)];
    if (errors.length) return reply.code(400).send({ error: 'INVALID_FLAG', message: errors.join(' '), issues: errors });

    const changes = describeChanges(current, next);
    if (changes.length === 0) return current;

    // Guardrail: some edits silently corrupt a running experiment. Refuse them
    // unless the caller explicitly accepts restarting it.
    const exposures = store.exposureCount(current.key, current.phase);
    const risks = exposures > 0 ? unsafeChanges(current, next) : [];
    const force = request.query.force === 'true';
    if (risks.length && !force) {
      return reply.code(409).send({
        error: 'UNSAFE_CHANGE',
        message: `This experiment already has ${exposures.toLocaleString('en-US')} exposures. ${risks.join(' ')} Re-send with ?force=true to apply it and restart the experiment.`,
        issues: risks,
      });
    }

    if (risks.length) {
      next = restart(next, current, now(), 'Restarted by a forced edit');
      changes.push(`Experiment restarted as phase ${next.phase} with a new salt (${exposures.toLocaleString('en-US')} exposures kept in phase ${current.phase})`);
    }
    store.transaction(() => {
      store.updateFlag(next, now());
      store.addAudit(next.key, next.version, changes.join('; '));
    });
    return next;
  });

  // Lifecycle: draft -> running -> stopped | rolled out -> archived. Each step is explicit and logged.

  function lifecycle(key: string, reply: FastifyReply, change: (flag: FlagConfig) => { next: FlagConfig; summary: string } | string) {
    const current = store.getFlag(key);
    if (!current) return notFound(reply, key);
    const result = change(current);
    if (typeof result === 'string') return reply.code(400).send({ error: 'INVALID_TRANSITION', message: result, issues: [result] });
    const next = { ...result.next, version: current.version + 1 };
    store.transaction(() => {
      store.updateFlag(next, now());
      store.addAudit(next.key, next.version, result.summary);
    });
    return next;
  }

  app.post<{ Params: { key: string } }>('/api/flags/:key/start', async (request, reply) =>
    lifecycle(request.params.key, reply, (flag) => {
      if (flag.status === 'running') return 'The experiment is already running.';
      if (flag.status === 'archived') return 'Archived flags cannot be started.';
      return { next: start(flag, now()), summary: flag.status === 'draft' ? 'Experiment started' : 'Experiment resumed' };
    })
  );

  app.post<{ Params: { key: string } }>('/api/flags/:key/stop', async (request, reply) =>
    lifecycle(request.params.key, reply, (flag) => {
      if (flag.status !== 'running' && flag.status !== 'rolled_out') return 'Only a running or rolled-out flag can be stopped.';
      return { next: setStatus(flag, 'stopped', now()), summary: 'Experiment stopped: everyone gets the default variant' };
    })
  );

  app.post<{ Params: { key: string } }>('/api/flags/:key/rollout', async (request, reply) => {
    const body = parse(rolloutBody, request.body, reply);
    if (!body) return;
    return lifecycle(request.params.key, reply, (flag) => {
      if (flag.status === 'archived') return 'Archived flags cannot be rolled out.';
      if (!flag.variants.some((v) => v.key === body.variant)) return `"${body.variant}" is not one of the variants.`;
      return { next: { ...setStatus(flag, 'rolled_out', now()), rolledOutVariant: body.variant }, summary: `Rolled out ${body.variant} to everyone` };
    });
  });

  app.post<{ Params: { key: string } }>('/api/flags/:key/restart', async (request, reply) => {
    const body = parse(restartBody, request.body ?? {}, reply);
    if (!body) return;
    return lifecycle(request.params.key, reply, (flag) => {
      if (flag.status === 'archived') return 'Archived flags cannot be restarted.';
      const reason = body.reason?.trim() || 'Restarted';
      const next = start(restart(flag, flag, now(), reason), now());
      return { next, summary: `Restarted as phase ${next.phase} with a new salt: ${reason}` };
    });
  });

  app.delete<{ Params: { key: string } }>('/api/flags/:key', async (request, reply) =>
    lifecycle(request.params.key, reply, (flag) => {
      if (flag.status === 'running') return 'Stop or roll out the experiment before archiving it.';
      return { next: setStatus(flag, 'archived', now()), summary: 'Archived' };
    })
  );

  app.get<{ Params: { key: string }; Querystring: { phase?: string } }>('/api/flags/:key/results', async (request, reply) => {
    const flag = store.getFlag(request.params.key);
    if (!flag) return notFound(reply, request.params.key);
    const phase = phaseOf(flag, request.query.phase, reply);
    if (phase === undefined) return;
    return analyzePhase(flag, phase).report;
  });

  app.get<{ Params: { key: string }; Querystring: { phase?: string } }>('/api/flags/:key/timeseries', async (request, reply) => {
    const flag = store.getFlag(request.params.key);
    if (!flag) return notFound(reply, request.params.key);
    const phase = phaseOf(flag, request.query.phase, reply);
    if (phase === undefined) return;
    const { flag: view, collected, report } = analyzePhase(flag, phase);
    return timeseries(view, collected.rows, report.alpha, {
      sequential: view.sequential ? { tuning: (report.requiredPerVariant ?? 5_000) * 2 } : undefined,
      cap: capFor(view.goal, collected.rows, 0),
    });
  });

  app.get<{ Params: { key: string } }>('/api/flags/:key/audit', async (request, reply) => {
    if (!store.getFlag(request.params.key)) return notFound(reply, request.params.key);
    return store.auditLog(request.params.key);
  });

  // --- holdouts ----------------------------------------------------------------

  function holdoutReport(holdout: Holdout) {
    // A holdout is read like an experiment whose control is the held-back group
    // and whose single treatment is "everything that shipped".
    const view = normalizeFlag({
      key: `holdout-${holdout.key}`,
      status: 'running',
      variants: [
        { key: HOLDOUT_VARIANTS.held, weight: holdout.percent },
        { key: HOLDOUT_VARIANTS.exposed, weight: 100 - holdout.percent },
      ],
      goal: holdout.metric,
      sequential: false,
      minRuntimeDays: 0,
    });
    const storeKey = HOLDOUT_PREFIX + holdout.key;
    const collected = collect(view, store.exposureRecords(storeKey, 0), store.eventRecords(storeKey, 0, metricEvents(view)), now());
    const report = analyze(view, buildInput(view, collected));
    const flags = store
      .listFlags()
      .filter((f) => f.holdout?.key === holdout.key)
      .map((f) => f.key);
    return { holdout, flags, report };
  }

  app.get('/api/holdouts', async () => store.listHoldouts().map(holdoutReport));

  app.post('/api/holdouts', async (request, reply) => {
    const body = parse(holdoutBody, request.body, reply);
    if (!body) return;
    if (store.getHoldout(body.key)) {
      return reply.code(409).send({ error: 'HOLDOUT_EXISTS', message: `A holdout named "${body.key}" already exists.` });
    }
    const holdout: Holdout = { key: body.key, description: body.description, percent: body.percent, metric: metric(body.metric), createdAt: now() };
    store.insertHoldout(holdout);
    return reply.code(201).send(holdout);
  });

  app.get<{ Params: { key: string } }>('/api/holdouts/:key', async (request, reply) => {
    const holdout = store.getHoldout(request.params.key);
    if (!holdout) return reply.code(404).send({ error: 'NOT_FOUND', message: `No holdout named "${request.params.key}".` });
    return holdoutReport(holdout);
  });

  // --- SDK keys ----------------------------------------------------------------

  app.get('/api/sdk-keys', async () => store.listSdkKeys());

  app.post('/api/sdk-keys', async (request, reply) => {
    const body = parse(sdkKeyBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(store.createSdkKey(body.environment, now()));
  });

  app.delete<{ Params: { key: string } }>('/api/sdk-keys/:key', async (request, reply) => {
    if (!store.deleteSdkKey(request.params.key)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such SDK key.' });
    return { deleted: true };
  });

  /**
   * Which environment a request speaks for. Until the first SDK key is
   * created the endpoints are open and everything is production, so a fresh
   * install works with no setup. After that, a valid key is required.
   */
  function environmentOf(request: FastifyRequest, reply: FastifyReply): string | undefined {
    if (!store.hasSdkKeys()) return PRODUCTION;
    const header = request.headers['x-sdk-key'];
    const environment = typeof header === 'string' ? store.environmentFor(header) : undefined;
    if (!environment) {
      reply.code(401).send({ error: 'INVALID_SDK_KEY', message: 'A valid SDK key is required in the x-sdk-key header.' });
      return undefined;
    }
    return environment;
  }

  // --- evaluation & ingestion ----------------------------------------------------

  /** Everything an SDK needs to evaluate flags locally, and nothing it does not. */
  app.get('/api/sdk/config', async (request, reply) => {
    const environment = environmentOf(request, reply);
    if (!environment) return;
    return { environment, flags: store.listFlags().map((f) => forSdk(f, environment)), generatedAt: now() };
  });

  app.post<{ Querystring: { dryRun?: string } }>('/api/evaluate', async (request, reply) => {
    const body = parse(evaluateBody, request.body, reply);
    if (!body) return;
    const dryRun = request.query.dryRun === 'true';
    // A dry run records nothing, so the dashboard can use it without a key.
    const environment = dryRun ? PRODUCTION : environmentOf(request, reply);
    if (!environment) return;
    const flag = store.getFlag(body.flagKey);
    if (!flag) return notFound(reply, body.flagKey);

    const result = evaluate(forSdk(flag, environment), body.user);
    if (!dryRun && environment === PRODUCTION) {
      if (result.holdout) {
        store.recordExposure(HOLDOUT_PREFIX + result.holdout.key, 0, result.unitId, result.holdout.held ? HOLDOUT_VARIANTS.held : HOLDOUT_VARIANTS.exposed, 0, now());
      }
      if (result.inExperiment) {
        store.recordExposure(flag.key, flag.phase, result.unitId, result.variant, flag.version, now(), exposureAttributes(flag, body.user));
      }
      if (body.user.anonymousId && body.user.anonymousId !== body.user.id) store.identify(body.user.anonymousId, body.user.id, now());
    }
    return result;
  });

  app.post('/api/exposures', async (request, reply) => {
    const body = parse(exposuresBody, request.body, reply);
    if (!body) return;
    const environment = environmentOf(request, reply);
    if (!environment) return;

    let accepted = 0;
    let rejected = 0;
    let ignored = 0;
    store.transaction(() => {
      for (const e of body.exposures) {
        if (environment !== PRODUCTION) {
          // Staging traffic must never reach the analysis.
          ignored++;
          continue;
        }
        if (e.flagKey.startsWith(HOLDOUT_PREFIX)) {
          const known = store.getHoldout(e.flagKey.slice(HOLDOUT_PREFIX.length));
          if (!known || (e.variant !== HOLDOUT_VARIANTS.held && e.variant !== HOLDOUT_VARIANTS.exposed)) rejected++;
          else {
            store.recordExposure(e.flagKey, 0, e.userId, e.variant, 0, e.timestamp ?? now());
            accepted++;
          }
          continue;
        }
        const flag = store.getFlag(e.flagKey);
        // An exposure from before a restart belongs to a phase that is closed.
        if (!flag || !flag.variants.some((v) => v.key === e.variant) || (e.phase !== undefined && e.phase !== flag.phase)) {
          rejected++;
          continue;
        }
        store.recordExposure(e.flagKey, flag.phase, e.userId, e.variant, e.version, e.timestamp ?? now(), e.attributes);
        accepted++;
      }
    });
    return { accepted, rejected, ignored };
  });

  app.post('/api/track', async (request, reply) => {
    const body = parse(trackBody, request.body, reply);
    if (!body) return;
    const environment = environmentOf(request, reply);
    if (!environment) return;
    const events = 'events' in body ? body.events : [body];
    let accepted = 0;
    let duplicates = 0;
    if (environment === PRODUCTION) {
      store.transaction(() => {
        for (const e of events) {
          if (store.recordEvent(e.userId, e.event, e.value ?? null, e.timestamp ?? now(), e.idempotencyKey ?? null)) accepted++;
          else duplicates++;
        }
      });
    }
    return reply.code(202).send({ accepted, duplicates });
  });

  /** Link an anonymous id to the account it became, so pre-login exposures and post-login conversions meet. */
  app.post('/api/identify', async (request, reply) => {
    const body = parse(identifyBody, request.body, reply);
    if (!body) return;
    const environment = environmentOf(request, reply);
    if (!environment) return;
    if (environment === PRODUCTION) store.identify(body.anonymousId, body.userId, now());
    return reply.code(202).send({ linked: environment === PRODUCTION });
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.register(fastifyStatic, { root: options.staticDir });
  }

  // --- helpers that need the store -----------------------------------------------

  /** Apply request fields to a flag. Returns an error message if a reference cannot be resolved. */
  function applyBody(base: FlagConfig, body: FlagBody): FlagConfig | string {
    const next: FlagConfig = { ...base };
    if (body.description !== undefined) next.description = body.description;
    if (body.rolloutPercent !== undefined) next.rolloutPercent = body.rolloutPercent;
    if (body.variants !== undefined) next.variants = body.variants;
    if (body.defaultVariant !== undefined) next.defaultVariant = body.defaultVariant;
    if (body.targeting !== undefined) next.targeting = body.targeting;
    if (body.overrides !== undefined) next.overrides = body.overrides;
    if (body.exclusion !== undefined) next.exclusion = body.exclusion;
    if (body.environments !== undefined) next.environments = body.environments;
    if (body.dimensions !== undefined) next.dimensions = body.dimensions;
    if (body.minDetectableEffect !== undefined) next.minDetectableEffect = body.minDetectableEffect;
    if (body.minRuntimeDays !== undefined) next.minRuntimeDays = body.minRuntimeDays;
    if (body.sequential !== undefined) next.sequential = body.sequential;
    if (body.cuped !== undefined) next.cuped = body.cuped;
    if (body.preExperimentDays !== undefined) next.preExperimentDays = body.preExperimentDays;
    if (body.goal !== undefined) next.goal = metric(body.goal);
    else if (body.primaryMetric !== undefined) next.goal = { ...base.goal, event: body.primaryMetric };
    if (body.guardrails !== undefined) next.guardrails = body.guardrails.map(metric);

    if (body.holdout !== undefined) {
      if (body.holdout === null) next.holdout = null;
      else {
        const holdout = store.getHoldout(body.holdout);
        if (!holdout) return `No holdout named "${body.holdout}".`;
        next.holdout = { key: holdout.key, percent: holdout.percent };
      }
    }

    // Anything the sample size depends on invalidates a locked plan, so it is planned again.
    const stated = body.expectedBaseline !== undefined || body.expectedBaselineSd !== undefined;
    const replanned =
      stated ||
      JSON.stringify(next.goal) !== JSON.stringify(base.goal) ||
      next.minDetectableEffect !== base.minDetectableEffect ||
      next.variants.length !== base.variants.length;
    if (replanned) {
      const keepObserved = !stated && base.plan.source !== 'observed';
      next.plan = {
        baseline: body.expectedBaseline !== undefined ? body.expectedBaseline : keepObserved ? base.plan.baseline : null,
        baselineSd: body.expectedBaselineSd !== undefined ? body.expectedBaselineSd : keepObserved ? base.plan.baselineSd : null,
        requiredPerVariant: null,
        source: null,
        lockedAt: null,
      };
    }
    return next;
  }

  /** Two tests in one exclusion group must not claim the same users. */
  function exclusionConflicts(flag: FlagConfig): string[] {
    if (!flag.exclusion) return [];
    const mine = flag.exclusion;
    return store
      .listFlags()
      .filter((other) => other.key !== flag.key && other.exclusion?.group === mine.group && (other.status === 'draft' || other.status === 'running'))
      .filter((other) => mine.start < other.exclusion!.end && other.exclusion!.start < mine.end)
      .map((other) => `Exclusion range ${mine.start}-${mine.end} overlaps "${other.key}" (${other.exclusion!.start}-${other.exclusion!.end}) in group "${mine.group}".`);
  }

  return app;
}

// --- helpers -------------------------------------------------------------------

/** Load one phase of an experiment and reduce it to the decision engine's input. */
export function readPhase(store: Store, flag: FlagConfig, phaseNumber: number, at: number): { flag: FlagConfig; collected: Collected; input: AnalysisInput } {
  // An old phase is read against the split it actually ran with, and without the current phase's plan.
  const view: FlagConfig =
    phaseNumber === flag.phase
      ? flag
      : {
          ...flag,
          variants: flag.phases.find((p) => p.number === phaseNumber)?.variants ?? flag.variants,
          plan: { ...flag.plan, requiredPerVariant: null, lockedAt: null, ...(flag.plan.source === 'observed' ? { baseline: null, baselineSd: null, source: null } : {}) },
        };
  const collected = collect(view, store.exposureRecords(flag.key, phaseNumber), store.eventRecords(flag.key, phaseNumber, metricEvents(view)), at);
  return { flag: view, collected, input: buildInput(view, collected) };
}

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

function phaseOf(flag: FlagConfig, raw: string | undefined, reply: FastifyReply): number | undefined {
  if (raw === undefined) return flag.phase;
  const phase = Number(raw);
  if (!flag.phases.some((p) => p.number === phase)) {
    reply.code(404).send({ error: 'NOT_FOUND', message: `"${flag.key}" has no phase ${raw}.` });
    return undefined;
  }
  return phase;
}

function newSalt(): string {
  return randomBytes(6).toString('hex');
}

function metricEvents(flag: FlagConfig): string[] {
  return [flag.goal, ...flag.guardrails].flatMap((m) => (m.denominatorEvent ? [m.event, m.denominatorEvent] : [m.event]));
}

function setStatus(flag: FlagConfig, status: FlagStatus, at: number): FlagConfig {
  return { ...flag, status, enabled: status === 'running' || status === 'rolled_out', statusChangedAt: at, rolledOutVariant: status === 'rolled_out' ? flag.rolledOutVariant : null };
}

function start(flag: FlagConfig, at: number): FlagConfig {
  const next = setStatus(flag, 'running', at);
  return { ...next, phases: next.phases.map((p) => (p.number === next.phase && p.startedAt === null ? { ...p, startedAt: at } : p)) };
}

/**
 * Close the current phase and open a new one with a fresh salt, so users are
 * re-randomized and the old data stays readable instead of being deleted.
 */
function restart(next: FlagConfig, previous: FlagConfig, at: number, reason: string): FlagConfig {
  const running = next.status === 'running';
  return {
    ...next,
    salt: newSalt(),
    phase: previous.phase + 1,
    phases: [
      ...previous.phases.map((p) => (p.number === previous.phase ? { ...p, endedAt: at, variants: previous.variants } : p)),
      { number: previous.phase + 1, startedAt: running ? at : null, endedAt: null, reason },
    ],
    plan: {
      baseline: next.plan.source === 'observed' ? null : next.plan.baseline,
      baselineSd: next.plan.source === 'observed' ? null : next.plan.baselineSd,
      requiredPerVariant: null,
      source: null,
      lockedAt: null,
    },
  };
}

/** The slice of a flag an SDK needs, as it should behave in the SDK's environment. */
function forSdk(flag: FlagConfig, environment: string): EvaluableFlag {
  // Outside production a flag is live only where it was switched on for testing.
  const live = environment === PRODUCTION ? flag.enabled : flag.status !== 'archived' && flag.environments.includes(environment);
  return {
    key: flag.key,
    enabled: live,
    status: environment === PRODUCTION ? flag.status : live ? 'running' : flag.status === 'archived' ? 'archived' : 'draft',
    salt: flag.salt,
    rolloutPercent: flag.rolloutPercent,
    variants: flag.variants,
    defaultVariant: flag.defaultVariant,
    rolledOutVariant: flag.rolledOutVariant,
    targeting: flag.targeting,
    overrides: flag.overrides,
    exclusion: flag.exclusion,
    holdout: flag.holdout,
    dimensions: flag.dimensions,
    phase: flag.phase,
    version: flag.version,
  };
}

function describePlan(flag: FlagConfig, plan: SamplePlan): string {
  const baseline = plan.baseline === null ? '' : flag.goal.kind === 'conversion' ? `${(plan.baseline * 100).toFixed(1)}%` : plan.baseline.toPrecision(3);
  return `Sample plan locked: ${plan.requiredPerVariant!.toLocaleString('en-US')} users per variant (${plan.source} baseline ${baseline})`;
}

const FIELD_LABELS: Partial<Record<keyof FlagConfig, string>> = {
  description: 'Description',
  enabled: 'Enabled',
  rolloutPercent: 'Rollout %',
  variants: 'Variants',
  defaultVariant: 'Default variant',
  targeting: 'Targeting',
  goal: 'Goal metric',
  guardrails: 'Guardrails',
  minDetectableEffect: 'Minimum detectable effect',
  minRuntimeDays: 'Minimum runtime (days)',
  sequential: 'Sequential testing',
  cuped: 'Variance reduction',
  preExperimentDays: 'Pre-experiment window (days)',
  overrides: 'Overrides',
  exclusion: 'Exclusion group',
  holdout: 'Holdout',
  environments: 'Test environments',
  dimensions: 'Dimensions',
};

function describeChanges(before: FlagConfig, after: FlagConfig): string[] {
  const changes = (Object.keys(FIELD_LABELS) as Array<keyof FlagConfig>)
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => `${FIELD_LABELS[f]}: ${short(before[f])} → ${short(after[f])}`);
  if (before.plan.baseline !== after.plan.baseline && after.plan.source !== 'observed' && before.plan.source !== 'observed') {
    changes.push(`Expected baseline: ${short(before.plan.baseline)} → ${short(after.plan.baseline)}`);
  }
  return changes;
}

function isMetric(value: unknown): value is MetricDef {
  return typeof value === 'object' && value !== null && 'event' in value && 'kind' in value;
}

function short(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'object' && v && 'key' in v && 'weight' in v)) {
    return (value as Array<{ key: string; weight: number }>).map((v) => `${v.key} ${v.weight}%`).join(' / ');
  }
  if (isMetric(value)) return metricLabel(value);
  if (Array.isArray(value) && value.length > 0 && value.every(isMetric)) return value.map(metricLabel).join(', ');
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Changes that would bias an experiment that already has exposures. Raising
 * the rollout is safe (bucketing only adds users); these are not.
 */
function unsafeChanges(before: FlagConfig, after: FlagConfig): string[] {
  const risks: string[] = [];
  const split = (f: FlagConfig) => JSON.stringify(f.variants.map((v) => [v.key, v.weight]));
  if (split(before) !== split(after)) {
    risks.push('Changing variants or weights mid-test moves users between arms and causes a sample ratio mismatch.');
  }
  if (after.rolloutPercent < before.rolloutPercent) {
    risks.push('Lowering the rollout drops users who were already exposed, which biases the comparison.');
  }
  if (JSON.stringify(before.targeting) !== JSON.stringify(after.targeting)) {
    risks.push('Changing targeting mid-test changes who is in the experiment.');
  }
  if (JSON.stringify(before.exclusion) !== JSON.stringify(after.exclusion) || JSON.stringify(before.holdout) !== JSON.stringify(after.holdout)) {
    risks.push('Changing the exclusion group or holdout mid-test changes who is in the experiment.');
  }
  return risks;
}
