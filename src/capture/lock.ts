/**
 * Single-instance guard for the capture daemon.
 *
 * Two daemons on one file would not corrupt anything (the upsert is
 * idempotent), but they would double the RPC load and make `poll_runs`
 * unreadable as a health signal.
 */

import { hostname } from 'os';
import type { Database } from 'better-sqlite3';
import { acquirePollLock, heartbeatPollLock, releasePollLock } from '../db/repo-write.js';

/** A lock is considered abandoned after three missed intervals. */
export const STALE_LOCK_INTERVALS = 3;

export interface CaptureLock {
  release(): void;
  heartbeat(): void;
}

/**
 * Take the lock, or throw with the holder's identity.
 * A lock whose heartbeat is older than three intervals is taken over.
 */
export function acquireCaptureLock(db: Database, intervalMs: number): CaptureLock {
  const pid = process.pid;
  const host = hostname();
  const state = acquirePollLock(db, pid, host, intervalMs * STALE_LOCK_INTERVALS);

  if (!state.acquired) {
    const held = state.heldBy;
    const ageSeconds = held ? Math.round((Date.now() - held.heartbeatAt) / 1000) : 0;
    throw new Error(
      `capture already running (pid ${held?.pid} on ${held?.host}, heartbeat ${ageSeconds}s ago)`
    );
  }

  if (state.tookOverStale) {
    console.warn('⚠️  Took over a stale capture lock — the previous daemon did not exit cleanly');
  }

  return {
    heartbeat: () => heartbeatPollLock(db, pid),
    release: () => releasePollLock(db, pid),
  };
}
