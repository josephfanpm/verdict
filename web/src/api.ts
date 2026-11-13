import type { ExperimentReport, MetricReport, MetricVariantResult, SegmentResult, VerdictKind } from '../../src/core/analyze';
import type { MetricInput } from '../../src/core/flag';
import type { TimeseriesPoint } from '../../src/core/timeseries';
import type { Evaluation, FlagConfig, MetricDef, MetricKind, UserContext } from '../../src/core/types';

export type { ExperimentReport, MetricReport, MetricVariantResult, SegmentResult, VerdictKind, Evaluation, FlagConfig, MetricDef, MetricKind, MetricInput, TimeseriesPoint };

export interface FlagSummary {
  flag: FlagConfig;
  summary: { verdict: VerdictKind; headline: string; totalExposures: number; progress: number; cleanup: string | null };
}

/** Fields accepted when creating or editing a flag. */
export interface FlagBody
  extends Partial<
    Pick<
      FlagConfig,
      | 'description'
      | 'enabled'
      | 'rolloutPercent'
      | 'variants'
      | 'defaultVariant'
      | 'targeting'
      | 'minDetectableEffect'
      | 'minRuntimeDays'
      | 'sequential'
      | 'cuped'
      | 'overrides'
      | 'exclusion'
      | 'environments'
      | 'dimensions'
    >
  > {
  key?: string;
  primaryMetric?: string;
  goal?: MetricInput;
  guardrails?: MetricInput[];
  expectedBaseline?: number | null;
  /** Key of an existing holdout. */
  holdout?: string | null;
}

export interface AuditEntry {
  id: number;
  version: number;
  summary: string;
  ts: number;
}

export interface SdkKey {
  key: string;
  environment: string;
  createdAt: number;
}

export interface HoldoutReadout {
  holdout: { key: string; description: string; percent: number; metric: MetricDef; createdAt: number };
  /** Flags that sit behind this holdout. */
  flags: string[];
  report: ExperimentReport;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: string[] = []
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'verdict.adminToken';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the token just won't persist.
  }
}

/**
 * The UI registers a handler that asks for the admin token in a dialog. Falls
 * back to the browser prompt if nothing is mounted (e.g. in a script).
 */
let tokenHandler: () => Promise<string | null> = async () => window.prompt('Admin token') || null;
export function setTokenHandler(handler: () => Promise<string | null>): void {
  tokenHandler = handler;
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const token = readToken();
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (response.status === 401 && !retried) {
    const entered = await tokenHandler();
    if (entered) {
      saveToken(entered);
      return request<T>(path, init, true);
    }
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? 'ERROR', data.message ?? response.statusText, data.issues);
  }
  return data as T;
}

const flagUrl = (key: string) => `/api/flags/${encodeURIComponent(key)}`;
const phaseQuery = (phase?: number) => (phase === undefined ? '' : `?phase=${phase}`);

export const api = {
  listFlags: () => request<FlagSummary[]>('/api/flags'),
  getFlag: (key: string) => request<FlagConfig>(flagUrl(key)),
  results: (key: string, phase?: number) => request<ExperimentReport>(`${flagUrl(key)}/results${phaseQuery(phase)}`),
  timeseries: (key: string, phase?: number) => request<TimeseriesPoint[]>(`${flagUrl(key)}/timeseries${phaseQuery(phase)}`),
  audit: (key: string) => request<AuditEntry[]>(`${flagUrl(key)}/audit`),
  createFlag: (body: FlagBody) => request<FlagConfig>('/api/flags', { method: 'POST', body }),
  updateFlag: (key: string, body: FlagBody, force = false) => request<FlagConfig>(`${flagUrl(key)}${force ? '?force=true' : ''}`, { method: 'PATCH', body }),
  start: (key: string) => request<FlagConfig>(`${flagUrl(key)}/start`, { method: 'POST' }),
  stop: (key: string) => request<FlagConfig>(`${flagUrl(key)}/stop`, { method: 'POST' }),
  rollout: (key: string, variant: string) => request<FlagConfig>(`${flagUrl(key)}/rollout`, { method: 'POST', body: { variant } }),
  restart: (key: string, reason: string) => request<FlagConfig>(`${flagUrl(key)}/restart`, { method: 'POST', body: { reason } }),
  archive: (key: string) => request<FlagConfig>(flagUrl(key), { method: 'DELETE' }),
  evaluate: (flagKey: string, user: UserContext) => request<Evaluation>('/api/evaluate?dryRun=true', { method: 'POST', body: { flagKey, user } }),
  holdouts: () => request<HoldoutReadout[]>('/api/holdouts'),
  createHoldout: (body: { key: string; percent: number; metric: string; description?: string }) => request<unknown>('/api/holdouts', { method: 'POST', body }),
  sdkKeys: () => request<SdkKey[]>('/api/sdk-keys'),
  createSdkKey: (environment: string) => request<SdkKey>('/api/sdk-keys', { method: 'POST', body: { environment } }),
  deleteSdkKey: (key: string) => request<unknown>(`/api/sdk-keys/${encodeURIComponent(key)}`, { method: 'DELETE' }),
};
