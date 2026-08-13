/**
 * SQLite handles for the processes that share `data/observations.sqlite`.
 *
 * Table ownership is disjoint by writer — capture owns the chain tables, the
 * findings cadence owns the derived tables, the daily analysis owns
 * `analysis_runs`, the server opens read-only — but that buys nothing for
 * concurrency: **SQLite serialises writers per FILE, not per table.** Four
 * writers really do contend, and the 10-minute capture and 10-minute findings
 * cadences are designed to run at the same period.
 *
 * What actually holds the system together is therefore: WAL (readers never
 * block the writer), a generous busy timeout, and — most importantly — the
 * fact that every database write on the capture cycle path is wrapped, so
 * losing the race costs one bookkeeping row rather than the daemon. See
 * `safeWrite` in capture/daemon.ts.
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
  // FULL, not NORMAL: an observation that cannot be re-fetched is worth more
  // than the fsync it costs. /data is frequently a spinning disk.
  db.pragma('synchronous = FULL');
  // Generous, because writers genuinely contend for this file and the
  // alternative to waiting is dropping a sample that no longer exists on chain.
  db.pragma('busy_timeout = 15000');
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
