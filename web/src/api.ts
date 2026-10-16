import type { ExperimentReport, VerdictKind } from '../../src/core/analyze';
import type { Evaluation, FlagConfig, UserContext } from '../../src/core/types';

export type { ExperimentReport, VerdictKind, Evaluation, FlagConfig };

export interface FlagSummary {
  flag: FlagConfig;
  summary: { verdict: VerdictKind; headline: string; totalExposures: number; progress: number };
}

export interface AuditEntry {
  id: number;
  version: number;
  summary: string;
  ts: number;
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
    const entered = window.prompt('This Verdict server requires an admin token to change flags:');
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

export const api = {
  listFlags: () => request<FlagSummary[]>('/api/flags'),
  getFlag: (key: string) => request<FlagConfig>(`/api/flags/${encodeURIComponent(key)}`),
  results: (key: string) => request<ExperimentReport>(`/api/flags/${encodeURIComponent(key)}/results`),
  audit: (key: string) => request<AuditEntry[]>(`/api/flags/${encodeURIComponent(key)}/audit`),
  createFlag: (body: Partial<FlagConfig>) => request<FlagConfig>('/api/flags', { method: 'POST', body }),
  updateFlag: (key: string, body: Partial<FlagConfig>, force = false) =>
    request<FlagConfig>(`/api/flags/${encodeURIComponent(key)}${force ? '?force=true' : ''}`, { method: 'PATCH', body }),
  evaluate: (flagKey: string, user: UserContext) =>
    request<Evaluation>('/api/evaluate?dryRun=true', { method: 'POST', body: { flagKey, user } }),
};
