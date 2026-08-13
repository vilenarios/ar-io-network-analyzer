/**
 * Write side of the observation store — owned by the capture daemon.
 *
 * The single invariant everything else depends on: `gateway_results`,
 * `report_tx_id` and `submitted_at` are never blind-overwritten. If a re-read
 * disagrees with what we already hold, the old row is copied into
 * `observation_revisions` and the revision counter bumps.
 */

import type { Database } from 'better-sqlite3';
import type { DecodedObservation, RegistrySnapshot } from '../observers/types.js';

export interface UpsertResult {
  inserted: number;
  updated: number;
  revisions: number;
}

interface ExistingRow {
  gateway_results: Buffer;
  gateway_count: number;
  report_tx_id: string;
  submitted_at: number;
  pubkey: string;
  revision: number;
}

/**
 * Insert or update one observation.
 *
 * Callers wrap a whole cycle in ONE transaction — this function never opens
 * one of its own.
 */
export function upsertObservation(
  db: Database,
  record: DecodedObservation,
  seenAt: number,
  seenSlot: number
): 'inserted' | 'updated' | 'revised' {
  const existing = db
    .prepare<[number, string], ExistingRow>(
      `SELECT gateway_results, gateway_count, report_tx_id, submitted_at, pubkey, revision
         FROM observations WHERE epoch_index = ? AND observer = ?`
    )
    .get(record.epochIndex, record.observer);

  if (!existing) {
    db.prepare(
      `INSERT INTO observations (
         epoch_index, observer, pubkey, gateway_results, gateway_count, report_tx_id,
         submitted_at, schema_major, schema_minor, schema_patch, account_bytes,
         suspect_timestamp, revision, first_seen_at, last_seen_at, first_seen_slot, last_seen_slot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(
      record.epochIndex,
      record.observer,
      record.pubkey,
      record.gatewayResults,
      record.gatewayCount,
      record.reportTxId,
      record.submittedAt,
      record.schemaVersion?.major ?? null,
      record.schemaVersion?.minor ?? null,
      record.schemaVersion?.patch ?? null,
      record.accountBytes,
      record.suspectTimestamp ? 1 : 0,
      seenAt,
      seenAt,
      seenSlot,
      seenSlot
    );
    return 'inserted';
  }

  const changed: string[] = [];
  if (!Buffer.from(existing.gateway_results).equals(record.gatewayResults)) {
    changed.push('gateway_results');
  }
  if (existing.report_tx_id !== record.reportTxId) changed.push('report_tx_id');
  if (existing.submitted_at !== record.submittedAt) changed.push('submitted_at');
  if (existing.gateway_count !== record.gatewayCount) changed.push('gateway_count');
  if (existing.pubkey !== record.pubkey) changed.push('pubkey');

  if (changed.length === 0) {
    db.prepare(
      `UPDATE observations SET last_seen_at = ?, last_seen_slot = ?
        WHERE epoch_index = ? AND observer = ?`
    ).run(seenAt, seenSlot, record.epochIndex, record.observer);
    return 'updated';
  }

  insertRevision(db, record.epochIndex, record.observer, existing, seenAt, seenSlot, changed);

  db.prepare(
    `UPDATE observations SET
       pubkey = ?, gateway_results = ?, gateway_count = ?, report_tx_id = ?, submitted_at = ?,
       schema_major = ?, schema_minor = ?, schema_patch = ?, account_bytes = ?,
       suspect_timestamp = ?, revision = revision + 1, last_seen_at = ?, last_seen_slot = ?
     WHERE epoch_index = ? AND observer = ?`
  ).run(
    record.pubkey,
    record.gatewayResults,
    record.gatewayCount,
    record.reportTxId,
    record.submittedAt,
    record.schemaVersion?.major ?? null,
    record.schemaVersion?.minor ?? null,
    record.schemaVersion?.patch ?? null,
    record.accountBytes,
    record.suspectTimestamp ? 1 : 0,
    seenAt,
    seenSlot,
    record.epochIndex,
    record.observer
  );

  return 'revised';
}

/** Append the superseded state of a row to the immutable revision log. */
export function insertRevision(
  db: Database,
  epochIndex: number,
  observer: string,
  previous: ExistingRow,
  supersededAt: number,
  supersededSlot: number,
  changedFields: string[]
): void {
  db.prepare(
    `INSERT INTO observation_revisions (
       epoch_index, observer, revision, gateway_results, gateway_count, report_tx_id,
       submitted_at, pubkey, superseded_at, superseded_slot, changed_fields
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    epochIndex,
    observer,
    previous.revision,
    previous.gateway_results,
    previous.gateway_count,
    previous.report_tx_id,
    previous.submitted_at,
    previous.pubkey,
    supersededAt,
    supersededSlot,
    JSON.stringify(changedFields)
  );
}

/** Batch form. The caller still owns the transaction. */
export function upsertObservations(
  db: Database,
  records: DecodedObservation[],
  seenAt: number,
  seenSlot: number
): UpsertResult {
  const result: UpsertResult = { inserted: 0, updated: 0, revisions: 0 };
  for (const record of records) {
    const outcome = upsertObservation(db, record, seenAt, seenSlot);
    if (outcome === 'inserted') result.inserted++;
    else if (outcome === 'updated') result.updated++;
    else {
      result.revisions++;
      result.updated++;
    }
  }
  return result;
}

/**
 * Store a registry slot-order snapshot for an epoch.
 *
 * Bit `i` of `gateway_results` maps to `slots[i]`, and slot order mutates as
 * gateways join and leave — without this the captured bitmaps become
 * permanently undecodable.
 */
export function insertRegistrySlots(db: Database, snapshot: RegistrySnapshot): void {
  db.prepare(
    `INSERT OR REPLACE INTO registry_snapshots
       (epoch_index, gateway_count, captured_at, captured_at_slot, registry_pubkey, digest)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.epochIndex,
    snapshot.gatewayCount,
    snapshot.capturedAt,
    snapshot.capturedAtSlot,
    snapshot.registryPubkey,
    snapshot.digest
  );

  db.prepare('DELETE FROM registry_slots WHERE epoch_index = ?').run(snapshot.epochIndex);

  const insert = db.prepare(
    'INSERT INTO registry_slots (epoch_index, slot_index, gateway_address) VALUES (?, ?, ?)'
  );
  snapshot.slots.forEach((address, index) => {
    insert.run(snapshot.epochIndex, index, address);
  });
}

/** Never /dev/null a decode failure — park the bytes and keep going. */
export function insertRawUnparsed(
  db: Database,
  pubkey: string,
  data: Buffer,
  reason: string,
  seenAt: number,
  seenSlot: number
): void {
  db.prepare(
    `INSERT INTO raw_unparsed (pubkey, data_b64, byte_length, reason, seen_at, seen_slot)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(pubkey, data.toString('base64'), data.length, reason, seenAt, seenSlot);
}

/** Open a poll run row in the 'running' state and return its id. */
export function startPollRun(db: Database, startedAt: number): number {
  const info = db
    .prepare(`INSERT INTO poll_runs (started_at, status) VALUES (?, 'running')`)
    .run(startedAt);
  return Number(info.lastInsertRowid);
}

export interface PollRunOutcome {
  contextSlot: number | null;
  accountCount: number | null;
  inserted: number | null;
  updated: number | null;
  revisions: number | null;
  unparsed: number | null;
  canaryCount: number | null;
  status: 'ok' | 'failed' | 'stale';
  error: string | null;
}

/**
 * Close a poll run. Called inside the cycle's transaction so that
 * "cycle N completed" is atomic with cycle N's data.
 */
export function finishPollRun(
  db: Database,
  id: number,
  startedAt: number,
  finishedAt: number,
  outcome: PollRunOutcome
): void {
  db.prepare(
    `UPDATE poll_runs SET
       finished_at = ?, context_slot = ?, account_count = ?, inserted_count = ?,
       updated_count = ?, revision_count = ?, unparsed_count = ?, canary_count = ?,
       status = ?, error = ?, duration_ms = ?
     WHERE id = ?`
  ).run(
    finishedAt,
    outcome.contextSlot,
    outcome.accountCount,
    outcome.inserted,
    outcome.updated,
    outcome.revisions,
    outcome.unparsed,
    outcome.canaryCount,
    outcome.status,
    outcome.error,
    finishedAt - startedAt,
    id
  );
}

export interface LockState {
  acquired: boolean;
  heldBy?: { pid: number; host: string; heartbeatAt: number };
  tookOverStale?: boolean;
}

/**
 * Single-instance guard. Refuses when a live heartbeat exists; takes over a
 * lock whose heartbeat is older than `staleAfterMs`.
 */
export function acquirePollLock(db: Database, pid: number, host: string, staleAfterMs: number) {
  const now = Date.now();
  let state: LockState = { acquired: false };

  const run = db.transaction(() => {
    const existing = db
      .prepare<
        [],
        { pid: number; host: string; heartbeat_at: number }
      >('SELECT pid, host, heartbeat_at FROM poll_lock WHERE id = 1')
      .get();

    if (existing && now - existing.heartbeat_at < staleAfterMs) {
      state = {
        acquired: false,
        heldBy: { pid: existing.pid, host: existing.host, heartbeatAt: existing.heartbeat_at },
      };
      return;
    }

    db.prepare(
      `INSERT INTO poll_lock (id, pid, host, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, host = excluded.host,
           acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`
    ).run(pid, host, now, now);

    state = { acquired: true, tookOverStale: !!existing };
  });
  run.immediate();

  return state;
}

export function heartbeatPollLock(db: Database, pid: number): void {
  db.prepare('UPDATE poll_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?').run(Date.now(), pid);
}

export function releasePollLock(db: Database, pid: number): void {
  db.prepare('DELETE FROM poll_lock WHERE id = 1 AND pid = ?').run(pid);
}

/** Open an analysis run row (daily `yarn analyze`) and return its id. */
export function startAnalysisRun(db: Database, startedAt: number): number {
  const info = db
    .prepare(`INSERT INTO analysis_runs (started_at, status) VALUES (?, 'running')`)
    .run(startedAt);
  return Number(info.lastInsertRowid);
}

export function finishAnalysisRun(
  db: Database,
  id: number,
  outcome: {
    status: 'ok' | 'failed';
    gatewayCount?: number;
    resolvedCount?: number;
    clusterCount?: number;
    error?: string | null;
  }
): void {
  db.prepare(
    `UPDATE analysis_runs SET finished_at = ?, gateway_count = ?, resolved_count = ?,
       cluster_count = ?, status = ?, error = ? WHERE id = ?`
  ).run(
    Date.now(),
    outcome.gatewayCount ?? null,
    outcome.resolvedCount ?? null,
    outcome.clusterCount ?? null,
    outcome.status,
    outcome.error ?? null,
    id
  );
}
