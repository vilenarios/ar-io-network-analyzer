/**
 * SQLite handles for the three processes that share `data/observations.sqlite`.
 *
 * Table ownership is disjoint by writer (capture owns the chain tables, the
 * analysis cadence owns the derived tables, the server opens read-only), so
 * WAL plus a 5s busy timeout is sufficient — there is no cross-process write
 * contention by construction.
 */

import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { applyMigrations } from './migrations.js';

export type { Database };

export const DEFAULT_DB_PATH = 'data/observations.sqlite';

/** Absolute path of the observation store. */
export function resolveDbPath(): string {
  return resolve(process.env.OBSERVER_DB_PATH || DEFAULT_DB_PATH);
}

/**
 * Open the file for writing, creating and migrating it if needed.
 *
 * Throws (rather than degrading) when the file cannot be opened: a capture
 * daemon that cannot persist is worse than a dead one.
 */
export function openWriter(): Database {
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  applyMigrations(db);
  return db;
}

/**
 * Open the file read-only. Used by the server for freshness only — it must
 * never create the file, and it must never block a writer.
 */
export function openReader(): Database {
  const db = new BetterSqlite3(resolveDbPath(), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Open the reader, returning null when the file is absent or unreadable.
 * The server stays up regardless of the database's state.
 */
export function tryOpenReader(): Database | null {
  try {
    return openReader();
  } catch {
    return null;
  }
}
