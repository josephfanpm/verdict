import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { EventRecord, ExposureRecord } from '../core/aggregate.js';
import { normalizeFlag, type FlagInput } from '../core/flag.js';
import type { FlagConfig, MetricDef } from '../core/types.js';

export interface AuditEntry {
  id: number;
  flagKey: string;
  version: number;
  summary: string;
  ts: number;
}

export interface SdkKey {
  key: string;
  environment: string;
  createdAt: number;
}

/** A group of users kept back from every flag that references it, to measure what shipping added up to. */
export interface Holdout {
  key: string;
  description: string;
  percent: number;
  /** The metric the holdout is read on. */
  metric: MetricDef;
  createdAt: number;
}

/** Exposure rows for a holdout live beside flag exposures under this key prefix. */
export const HOLDOUT_PREFIX = 'holdout:';
export const HOLDOUT_VARIANTS = { held: 'holdout', exposed: 'exposed' } as const;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS flags (
    key         TEXT PRIMARY KEY,
    config      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- One row per user per flag per phase. The first exposure wins, so a user is
  -- counted in exactly one variant even if they are evaluated thousands of times.
  -- A restart opens a new phase instead of deleting rows, so old results stay readable.
  CREATE TABLE IF NOT EXISTS exposures (
    flag_key        TEXT    NOT NULL,
    phase           INTEGER NOT NULL DEFAULT 1,
    user_id         TEXT    NOT NULL,
    variant         TEXT    NOT NULL,
    config_version  INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    attributes      TEXT,
    conflict        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (flag_key, phase, user_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    value            REAL,
    ts               INTEGER NOT NULL,
    idempotency_key  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_user_name_ts ON events (user_id, name, ts);
  CREATE INDEX IF NOT EXISTS idx_events_name ON events (name);

  -- Identity links: an anonymous id and the account id it turned into are one user.
  CREATE TABLE IF NOT EXISTS aliases (
    alias      TEXT PRIMARY KEY,
    canonical  TEXT    NOT NULL,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases (canonical);

  CREATE TABLE IF NOT EXISTS sdk_keys (
    key          TEXT PRIMARY KEY,
    environment  TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS holdouts (
    key         TEXT PRIMARY KEY,
    config      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key  TEXT    NOT NULL,
    version   INTEGER NOT NULL,
    summary   TEXT    NOT NULL,
    ts        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_flag ON audit_log (flag_key, id);
`;

/** Thin persistence layer over SQLite (Node's built-in driver, so there is nothing to install). */
export class Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  /** Bumped on every write, so callers can cache anything derived from the data. */
  revision = 0;

  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.db.exec(SCHEMA);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON events (idempotency_key) WHERE idempotency_key IS NOT NULL');
  }

  /** Upgrade a database created by an earlier version in place. */
  private migrate(): void {
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    const exposures = columns('exposures');
    if (exposures.length > 0 && !exposures.includes('phase')) {
      this.db.exec(`
        ALTER TABLE exposures RENAME TO exposures_v1;
        CREATE TABLE exposures (
          flag_key TEXT NOT NULL, phase INTEGER NOT NULL DEFAULT 1, user_id TEXT NOT NULL, variant TEXT NOT NULL,
          config_version INTEGER NOT NULL, ts INTEGER NOT NULL, attributes TEXT, conflict INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (flag_key, phase, user_id)
        );
        INSERT INTO exposures (flag_key, phase, user_id, variant, config_version, ts)
          SELECT flag_key, 1, user_id, variant, config_version, ts FROM exposures_v1;
        DROP TABLE exposures_v1;
      `);
    }
    const events = columns('events');
    if (events.length > 0 && !events.includes('idempotency_key')) {
      this.db.exec('ALTER TABLE events ADD COLUMN idempotency_key TEXT');
    }
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /** Run fn inside a single transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- flags ---------------------------------------------------------------

  listFlags(includeArchived = false): FlagConfig[] {
    const rows = this.sql('SELECT config FROM flags ORDER BY created_at, key').all() as Array<{ config: string }>;
    const flags = rows.map((r) => normalizeFlag(JSON.parse(r.config) as FlagInput));
    return includeArchived ? flags : flags.filter((f) => f.status !== 'archived');
  }

  getFlag(key: string): FlagConfig | undefined {
    const row = this.sql('SELECT config FROM flags WHERE key = ?').get(key) as { config: string } | undefined;
    return row ? normalizeFlag(JSON.parse(row.config) as FlagInput) : undefined;
  }

  insertFlag(flag: FlagConfig, now = Date.now()): void {
    this.sql('INSERT INTO flags (key, config, created_at, updated_at) VALUES (?, ?, ?, ?)').run(flag.key, JSON.stringify(flag), now, now);
    this.revision++;
  }

  updateFlag(flag: FlagConfig, now = Date.now()): void {
    this.sql('UPDATE flags SET config = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(flag), now, flag.key);
    this.revision++;
  }

  // --- exposures & events --------------------------------------------------

  /**
   * Record that a user saw a variant. The first exposure wins. If the same id
   * later shows up in a different variant, the row is marked as a conflict so
   * the analysis can leave that user out and count how often it happens.
   */
  recordExposure(
    flagKey: string,
    phase: number,
    userId: string,
    variant: string,
    version: number,
    ts = Date.now(),
    attributes?: Record<string, string>
  ): 'new' | 'duplicate' | 'conflict' {
    const result = this.sql(
      'INSERT OR IGNORE INTO exposures (flag_key, phase, user_id, variant, config_version, ts, attributes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(flagKey, phase, userId, variant, version, ts, attributes ? JSON.stringify(attributes) : null);
    if (Number(result.changes) > 0) {
      this.revision++;
      return 'new';
    }
    const existing = this.sql('SELECT variant FROM exposures WHERE flag_key = ? AND phase = ? AND user_id = ?').get(flagKey, phase, userId) as
      | { variant: string }
      | undefined;
    if (existing && existing.variant !== variant) {
      this.sql('UPDATE exposures SET conflict = 1 WHERE flag_key = ? AND phase = ? AND user_id = ?').run(flagKey, phase, userId);
      this.revision++;
      return 'conflict';
    }
    return 'duplicate';
  }

  exposureCount(flagKey: string, phase: number): number {
    const row = this.sql('SELECT COUNT(*) AS n FROM exposures WHERE flag_key = ? AND phase = ?').get(flagKey, phase) as { n: number };
    return Number(row.n);
  }

  /** Returns false when an event with the same idempotency key was already stored. */
  recordEvent(userId: string, name: string, value: number | null = null, ts = Date.now(), idempotencyKey: string | null = null): boolean {
    const result = this.sql('INSERT OR IGNORE INTO events (user_id, name, value, ts, idempotency_key) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      name,
      value,
      ts,
      idempotencyKey
    );
    if (Number(result.changes) === 0) return false;
    this.revision++;
    return true;
  }

  /** Link an earlier id (anonymous, device) to the account it belongs to. Both then count as one user. */
  identify(alias: string, userId: string, ts = Date.now()): void {
    if (alias === userId) return;
    const target = (this.sql('SELECT canonical FROM aliases WHERE alias = ?').get(userId) as { canonical: string } | undefined)?.canonical ?? userId;
    if (alias === target) return;
    this.sql('INSERT INTO aliases (alias, canonical, ts) VALUES (?, ?, ?) ON CONFLICT (alias) DO UPDATE SET canonical = excluded.canonical').run(alias, target, ts);
    // Anything that pointed at the alias now points at the account too.
    this.sql('UPDATE aliases SET canonical = ? WHERE canonical = ?').run(target, alias);
    this.revision++;
  }

  /** Every exposure in a phase, with identity links applied. */
  exposureRecords(flagKey: string, phase: number): ExposureRecord[] {
    const rows = this.sql(
      `SELECT COALESCE(a.canonical, e.user_id) AS unit, e.variant AS variant, e.ts AS ts, e.attributes AS attributes, e.conflict AS conflict
       FROM exposures e LEFT JOIN aliases a ON a.alias = e.user_id
       WHERE e.flag_key = ? AND e.phase = ?`
    ).all(flagKey, phase) as Array<{ unit: string; variant: string; ts: number; attributes: string | null; conflict: number }>;
    return rows.map((r) => ({
      unit: r.unit,
      variant: r.variant,
      ts: Number(r.ts),
      attributes: r.attributes ? (JSON.parse(r.attributes) as Record<string, string>) : null,
      conflict: Number(r.conflict) === 1,
    }));
  }

  /** Events with the given names from users exposed in a phase, with identity links applied. */
  eventRecords(flagKey: string, phase: number, names: string[]): EventRecord[] {
    const unique = [...new Set(names)];
    if (unique.length === 0) return [];
    const rows = this.sql(
      `WITH units AS (
         SELECT DISTINCT COALESCE(a.canonical, e.user_id) AS unit
         FROM exposures e LEFT JOIN aliases a ON a.alias = e.user_id
         WHERE e.flag_key = ? AND e.phase = ?
       )
       SELECT COALESCE(a.canonical, ev.user_id) AS unit, ev.name AS name, ev.value AS value, ev.ts AS ts
       FROM events ev LEFT JOIN aliases a ON a.alias = ev.user_id
       WHERE ev.name IN (${unique.map(() => '?').join(', ')})
         AND COALESCE(a.canonical, ev.user_id) IN (SELECT unit FROM units)`
    ).all(flagKey, phase, ...unique) as Array<{ unit: string; name: string; value: number | null; ts: number }>;
    return rows.map((r) => ({ unit: r.unit, name: r.name, value: r.value === null ? null : Number(r.value), ts: Number(r.ts) }));
  }

  // --- SDK keys ------------------------------------------------------------

  createSdkKey(environment: string, now = Date.now()): SdkKey {
    const key = `sdk-${environment.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}-${randomBytes(12).toString('hex')}`;
    this.sql('INSERT INTO sdk_keys (key, environment, created_at) VALUES (?, ?, ?)').run(key, environment, now);
    this.revision++;
    return { key, environment, createdAt: now };
  }

  listSdkKeys(): SdkKey[] {
    const rows = this.sql('SELECT key, environment, created_at FROM sdk_keys ORDER BY created_at, key').all() as Array<{ key: string; environment: string; created_at: number }>;
    return rows.map((r) => ({ key: r.key, environment: r.environment, createdAt: Number(r.created_at) }));
  }

  deleteSdkKey(key: string): boolean {
    this.revision++;
    return Number(this.sql('DELETE FROM sdk_keys WHERE key = ?').run(key).changes) > 0;
  }

  environmentFor(key: string): string | undefined {
    return (this.sql('SELECT environment FROM sdk_keys WHERE key = ?').get(key) as { environment: string } | undefined)?.environment;
  }

  hasSdkKeys(): boolean {
    return Number((this.sql('SELECT COUNT(*) AS n FROM sdk_keys').get() as { n: number }).n) > 0;
  }

  // --- holdouts ------------------------------------------------------------

  listHoldouts(): Holdout[] {
    const rows = this.sql('SELECT config FROM holdouts ORDER BY created_at, key').all() as Array<{ config: string }>;
    return rows.map((r) => JSON.parse(r.config) as Holdout);
  }

  getHoldout(key: string): Holdout | undefined {
    const row = this.sql('SELECT config FROM holdouts WHERE key = ?').get(key) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as Holdout) : undefined;
  }

  insertHoldout(holdout: Holdout): void {
    this.sql('INSERT INTO holdouts (key, config, created_at) VALUES (?, ?, ?)').run(holdout.key, JSON.stringify(holdout), holdout.createdAt);
    this.revision++;
  }

  // --- audit log -----------------------------------------------------------

  addAudit(flagKey: string, version: number, summary: string, ts = Date.now()): void {
    this.sql('INSERT INTO audit_log (flag_key, version, summary, ts) VALUES (?, ?, ?, ?)').run(flagKey, version, summary, ts);
  }

  auditLog(flagKey: string): AuditEntry[] {
    const rows = this.sql('SELECT id, flag_key, version, summary, ts FROM audit_log WHERE flag_key = ? ORDER BY id DESC').all(flagKey) as Array<{
      id: number;
      flag_key: string;
      version: number;
      summary: string;
      ts: number;
    }>;
    return rows.map((r) => ({ id: Number(r.id), flagKey: r.flag_key, version: Number(r.version), summary: r.summary, ts: Number(r.ts) }));
  }
}
