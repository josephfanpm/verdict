import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExposureRow } from '../core/timeseries.js';
import type { FlagConfig, VariantCounts } from '../core/types.js';

export interface AuditEntry {
  id: number;
  flagKey: string;
  version: number;
  summary: string;
  ts: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS flags (
    key         TEXT PRIMARY KEY,
    config      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- One row per user per flag. The first exposure wins, so a user is counted
  -- in exactly one variant even if they are evaluated thousands of times.
  CREATE TABLE IF NOT EXISTS exposures (
    flag_key        TEXT    NOT NULL,
    user_id         TEXT    NOT NULL,
    variant         TEXT    NOT NULL,
    config_version  INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    PRIMARY KEY (flag_key, user_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    value    REAL,
    ts       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_user_name_ts ON events (user_id, name, ts);

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

  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
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

  listFlags(): FlagConfig[] {
    const rows = this.db.prepare('SELECT config FROM flags ORDER BY created_at, key').all() as Array<{ config: string }>;
    return rows.map((r) => JSON.parse(r.config) as FlagConfig);
  }

  getFlag(key: string): FlagConfig | undefined {
    const row = this.db.prepare('SELECT config FROM flags WHERE key = ?').get(key) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as FlagConfig) : undefined;
  }

  insertFlag(flag: FlagConfig, now = Date.now()): void {
    this.db.prepare('INSERT INTO flags (key, config, created_at, updated_at) VALUES (?, ?, ?, ?)').run(flag.key, JSON.stringify(flag), now, now);
  }

  updateFlag(flag: FlagConfig, now = Date.now()): void {
    this.db.prepare('UPDATE flags SET config = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(flag), now, flag.key);
  }

  // --- exposures & events --------------------------------------------------

  /** Returns true if this was the user's first exposure to the flag. */
  recordExposure(flagKey: string, userId: string, variant: string, version: number, ts = Date.now()): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO exposures (flag_key, user_id, variant, config_version, ts) VALUES (?, ?, ?, ?, ?)')
      .run(flagKey, userId, variant, version, ts);
    return Number(result.changes) > 0;
  }

  exposureCount(flagKey: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM exposures WHERE flag_key = ?').get(flagKey) as { n: number };
    return Number(row.n);
  }

  clearExposures(flagKey: string): number {
    return Number(this.db.prepare('DELETE FROM exposures WHERE flag_key = ?').run(flagKey).changes);
  }

  recordEvent(userId: string, name: string, value: number | null = null, ts = Date.now()): void {
    this.db.prepare('INSERT INTO events (user_id, name, value, ts) VALUES (?, ?, ?, ?)').run(userId, name, value, ts);
  }

  /**
   * Exposures and conversions per variant. A conversion only counts if the
   * event happened at or after the user's first exposure: something a user did
   * before seeing the variant cannot have been caused by it.
   */
  variantCounts(flagKey: string, metric: string): VariantCounts[] {
    const rows = this.db
      .prepare(
        `SELECT e.variant AS variant,
                COUNT(*)  AS exposures,
                SUM(CASE WHEN EXISTS (
                      SELECT 1 FROM events ev
                      WHERE ev.user_id = e.user_id AND ev.name = ? AND ev.ts >= e.ts
                    ) THEN 1 ELSE 0 END) AS conversions
         FROM exposures e
         WHERE e.flag_key = ?
         GROUP BY e.variant`
      )
      .all(metric, flagKey) as Array<{ variant: string; exposures: number; conversions: number }>;
    return rows.map((r) => ({ variant: r.variant, exposures: Number(r.exposures), conversions: Number(r.conversions) }));
  }

  /** Every exposure with the time of the user's first qualifying conversion, oldest first. */
  exposureRows(flagKey: string, metric: string): ExposureRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.variant AS variant,
                e.ts      AS ts,
                (SELECT MIN(ev.ts) FROM events ev
                 WHERE ev.user_id = e.user_id AND ev.name = ? AND ev.ts >= e.ts) AS convertedAt
         FROM exposures e
         WHERE e.flag_key = ?
         ORDER BY e.ts`
      )
      .all(metric, flagKey) as Array<{ variant: string; ts: number; convertedAt: number | null }>;
    return rows.map((r) => ({ variant: r.variant, ts: Number(r.ts), convertedAt: r.convertedAt === null ? null : Number(r.convertedAt) }));
  }

  // --- audit log -----------------------------------------------------------

  addAudit(flagKey: string, version: number, summary: string, ts = Date.now()): void {
    this.db.prepare('INSERT INTO audit_log (flag_key, version, summary, ts) VALUES (?, ?, ?, ?)').run(flagKey, version, summary, ts);
  }

  auditLog(flagKey: string): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT id, flag_key, version, summary, ts FROM audit_log WHERE flag_key = ? ORDER BY id DESC')
      .all(flagKey) as Array<{ id: number; flag_key: string; version: number; summary: string; ts: number }>;
    return rows.map((r) => ({ id: Number(r.id), flagKey: r.flag_key, version: Number(r.version), summary: r.summary, ts: Number(r.ts) }));
  }
}
