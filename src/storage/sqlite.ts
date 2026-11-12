import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

export type DB = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  /** Create the storage directory if missing. */
  create?: boolean;
}

/**
 * Small adapter around better-sqlite3. All SQL uses parameter binding.
 * WAL mode lets readers see a stable committed generation while a writer works.
 */
export function openDatabase(dbPath: string, opts: OpenOptions = {}): DB {
  if (opts.create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
  db.pragma('busy_timeout = 10000');
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = OFF');
  }
  return db;
}

export function getSchemaVersion(db: DB): number {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='index_meta'").get();
  if (!row) return 0;
  const v = db.prepare("SELECT value FROM index_meta WHERE key='schemaVersion'").get() as { value: string } | undefined;
  return v ? Number(JSON.parse(v.value)) : 0;
}

/**
 * Apply migrations. An incompatible (newer or unknown) schema is rebuilt from scratch:
 * the graph is a cache that can always be regenerated from source.
 */
export function migrate(db: DB): { rebuilt: boolean } {
  const current = getSchemaVersion(db);
  if (current === SCHEMA_VERSION) return { rebuilt: false };
  let rebuilt = false;
  if (current > SCHEMA_VERSION || current === 0) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    db.transaction(() => {
      for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name.replace(/"/g, '""')}"`);
    })();
    rebuilt = current !== 0;
  }
  const start = current > SCHEMA_VERSION ? 0 : current;
  db.transaction(() => {
    for (let v = start; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]);
    db.prepare("INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schemaVersion', ?)").run(JSON.stringify(SCHEMA_VERSION));
  })();
  return { rebuilt };
}

export function getMeta<T = unknown>(db: DB, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setMeta(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}
