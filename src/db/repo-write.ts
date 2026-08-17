/**
 * Write side of the observation store — owned by the capture daemon.
 *
 * The single invariant everything else depends on: `gateway_results`,
 * `report_tx_id` and `submitted_at` are never blind-overwritten. If a re-read
 * disagrees with what we already hold, the old row is copied into
 * `observation_revisions` and the revision counter bumps.
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { DecodedObservation, RegistrySnapshot } from '../observers/types.js';
import type { DecodedEpoch } from '../capture/decode.js';

export interface UpsertResult {
  inserted: number;
  updated: number;
  revisions: number;
  /** Reads refused because they were older than what we already hold. */
  stale: number;
  /** Two accounts in one read claiming the same (epoch, observer). */
  duplicateKeys: number;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'revised' | 'stale';

interface ExistingRow {
  gateway_results: Buffer;
  gateway_count: number;
  report_tx_id: string;
  submitted_at: number;
  pubkey: string;
  revision: number;
  last_seen_slot: number;
}

/**
 * Insert or update one observation.
 *
 * MONOTONIC, not merely idempotent. RPC providers load-balance across
 * replicas, and a lagging replica happily serves an older version of an
 * account. Overwriting newer data with older data would silently corrupt every
 * downstream Hamming score and finding — the newer bytes would survive only in
 * `observation_revisions`, which nothing reads. So a read that is older by
 * either clock (chain `submittedAt`, or the RPC context slot it was read at)
 * is refused outright and reported as `'stale'`.
 *
 * Callers wrap a whole cycle in ONE transaction — this function never opens
 * one of its own.
 */
export function upsertObservation(
  db: Database,
  record: DecodedObservation,
  seenAt: number,
  seenSlot: number
): UpsertOutcome {
  const existing = db
    .prepare<[number, string], ExistingRow>(
      `SELECT gateway_results, gateway_count, report_tx_id, submitted_at, pubkey, revision,
              last_seen_slot
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
    // Never regress the provenance columns either: a stale replica must not
    // make the row claim it was last confirmed at an older slot.
    db.prepare(
      `UPDATE observations SET last_seen_at = MAX(last_seen_at, ?), last_seen_slot = MAX(last_seen_slot, ?)
        WHERE epoch_index = ? AND observer = ?`
    ).run(seenAt, seenSlot, record.epochIndex, record.observer);
    return 'updated';
  }

  // The ordering guard. Either clock going backwards means this read came from
  // a replica behind the one that produced the row we already hold.
  if (record.submittedAt < existing.submitted_at || seenSlot < existing.last_seen_slot) {
    return 'stale';
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

/**
 * Batch form. The caller still owns the transaction.
 *
 * `(epoch_index, observer)` is the primary key because `report_tx_id` is NOT
 * unique — seven epoch-511 observers shared one report — but it is not the
 * chain's natural key, `pubkey` is. Two live accounts claiming one
 * `(epoch, observer)` would therefore collapse into a single row with array
 * order deciding the winner, which is indistinguishable from a legitimate
 * mid-cycle update. Detect it here and report it so the caller can shout.
 */
export function upsertObservations(
  db: Database,
  records: DecodedObservation[],
  seenAt: number,
  seenSlot: number
): UpsertResult {
  const result: UpsertResult = {
    inserted: 0,
    updated: 0,
    revisions: 0,
    stale: 0,
    duplicateKeys: 0,
  };

  const seenKeys = new Set<string>();
  for (const record of records) {
    const key = `${record.epochIndex}|${record.observer}`;
    if (seenKeys.has(key)) result.duplicateKeys++;
    seenKeys.add(key);

    const outcome = upsertObservation(db, record, seenAt, seenSlot);
    if (outcome === 'inserted') result.inserted++;
    else if (outcome === 'updated') result.updated++;
    else if (outcome === 'stale') result.stale++;
    else {
      result.revisions++;
      result.updated++;
    }
  }
  return result;
}

/** The `(epoch, observer)` keys appearing more than once in one read. */
export function duplicateObservationKeys(records: DecodedObservation[]): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = `${record.epochIndex}|${record.observer}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
}

/**
 * Store a registry slot-order snapshot for an epoch.
 *
 * Bit `i` of `gateway_results` maps to `slots[i]`, and slot order mutates as
 * gateways join and leave — without this the captured bitmaps become
 * permanently undecodable.
 */
export interface EpochUpsertResult {
  inserted: number;
  updated: number;
  stale: number;
}

/**
 * Record the Epoch accounts seen in one poll.
 *
 * An Epoch account is mutable while its epoch is live — tally_index and
 * observations_submitted advance, then rewards_distributed flips — so this is
 * last-write-wins on every mutable field, with first_seen_at preserved.
 *
 * The `last_seen_slot` guard is the same one the observation path uses: an RPC
 * node that has fallen behind must not overwrite a newer capture with an older
 * view of the same account.
 */
export function upsertEpochs(
  db: Database,
  records: DecodedEpoch[],
  seenAt: number,
  seenSlot: number
): EpochUpsertResult {
  const result: EpochUpsertResult = { inserted: 0, updated: 0, stale: 0 };

  const statement = db.prepare(
    `INSERT INTO epochs (
       epoch_index, start_timestamp, end_timestamp,
       total_eligible_rewards, per_gateway_reward, per_observer_reward, reward_rate,
       active_gateway_count, observer_count, name_count,
       observations_submitted, rewards_distributed, weights_tallied, prescriptions_done,
       distribution_index, tally_index,
       failure_counts, has_observed,
       prescribed_observers, prescribed_observer_gateways, prescribed_name_hashes,
       account_bytes, first_seen_at, last_seen_at, first_seen_slot, last_seen_slot, pubkey
     ) VALUES (
       @epochIndex, @startTimestamp, @endTimestamp,
       @totalEligibleRewards, @perGatewayReward, @perObserverReward, @rewardRate,
       @activeGatewayCount, @observerCount, @nameCount,
       @observationsSubmitted, @rewardsDistributed, @weightsTallied, @prescriptionsDone,
       @distributionIndex, @tallyIndex,
       @failureCounts, @hasObserved,
       @prescribedObservers, @prescribedObserverGateways, @prescribedNameHashes,
       @accountBytes, @seenAt, @seenAt, @seenSlot, @seenSlot, @pubkey
     )
     ON CONFLICT(epoch_index) DO UPDATE SET
       start_timestamp              = excluded.start_timestamp,
       end_timestamp                = excluded.end_timestamp,
       total_eligible_rewards       = excluded.total_eligible_rewards,
       per_gateway_reward           = excluded.per_gateway_reward,
       per_observer_reward          = excluded.per_observer_reward,
       reward_rate                  = excluded.reward_rate,
       active_gateway_count         = excluded.active_gateway_count,
       observer_count               = excluded.observer_count,
       name_count                   = excluded.name_count,
       observations_submitted       = excluded.observations_submitted,
       rewards_distributed          = excluded.rewards_distributed,
       weights_tallied              = excluded.weights_tallied,
       prescriptions_done           = excluded.prescriptions_done,
       distribution_index           = excluded.distribution_index,
       tally_index                  = excluded.tally_index,
       failure_counts               = excluded.failure_counts,
       has_observed                 = excluded.has_observed,
       prescribed_observers         = excluded.prescribed_observers,
       prescribed_observer_gateways = excluded.prescribed_observer_gateways,
       prescribed_name_hashes       = excluded.prescribed_name_hashes,
       account_bytes                = excluded.account_bytes,
       pubkey                       = excluded.pubkey,
       last_seen_at                 = excluded.last_seen_at,
       last_seen_slot               = excluded.last_seen_slot
     WHERE excluded.last_seen_slot >= epochs.last_seen_slot`
  );

  const exists = db.prepare('SELECT 1 FROM epochs WHERE epoch_index = ?');

  for (const record of records) {
    const { epoch } = record;
    const seenBefore = exists.get(epoch.epochIndex) !== undefined;

    const info = statement.run({
      epochIndex: epoch.epochIndex,
      startTimestamp: epoch.startTimestamp,
      endTimestamp: epoch.endTimestamp,
      totalEligibleRewards: epoch.totalEligibleRewards,
      perGatewayReward: epoch.perGatewayReward,
      perObserverReward: epoch.perObserverReward,
      rewardRate: epoch.rewardRate,
      activeGatewayCount: epoch.activeGatewayCount,
      observerCount: epoch.observerCount,
      nameCount: epoch.nameCount,
      observationsSubmitted: epoch.observationsSubmitted,
      rewardsDistributed: epoch.rewardsDistributed,
      weightsTallied: epoch.weightsTallied,
      prescriptionsDone: epoch.prescriptionsDone,
      distributionIndex: epoch.distributionIndex,
      tallyIndex: epoch.tallyIndex,
      failureCounts: Buffer.from(
        epoch.failureCounts.buffer,
        epoch.failureCounts.byteOffset,
        epoch.failureCounts.byteLength
      ),
      hasObserved: Buffer.from(
        epoch.hasObserved.buffer,
        epoch.hasObserved.byteOffset,
        epoch.hasObserved.byteLength
      ),
      prescribedObservers: JSON.stringify(epoch.prescribedObservers),
      prescribedObserverGateways: JSON.stringify(epoch.prescribedObserverGateways),
      prescribedNameHashes: JSON.stringify(
        epoch.prescribedNameHashes.map((hash) => Buffer.from(hash).toString('hex'))
      ),
      accountBytes: record.accountBytes,
      pubkey: record.pubkey,
      seenAt,
      seenSlot,
    });

    if (info.changes === 0) result.stale++;
    else if (seenBefore) result.updated++;
    else result.inserted++;
  }

  return result;
}

/**
 * Record who paid to create an epoch. Written once — creation never changes,
 * and `WHERE created_by IS NULL` keeps a re-resolve from churning the row.
 */
export function setEpochCreator(
  db: Database,
  epochIndex: number,
  creator: string,
  createdAt: number
): boolean {
  const info = db
    .prepare(
      `UPDATE epochs
          SET created_by = ?,
              created_at = ?,
              create_lag_seconds = ? - start_timestamp
        WHERE epoch_index = ? AND created_by IS NULL`
    )
    .run(creator, createdAt, createdAt, epochIndex);
  return info.changes > 0;
}

/** Epochs whose creator has not been resolved yet, oldest first. */
export function epochsMissingCreator(db: Database, limit: number): {
  epochIndex: number;
  pubkey: string;
}[] {
  return db
    .prepare(
      `SELECT epoch_index AS epochIndex, pubkey
         FROM epochs
        WHERE created_by IS NULL AND pubkey IS NOT NULL
        ORDER BY epoch_index ASC
        LIMIT ?`
    )
    .all(limit) as { epochIndex: number; pubkey: string }[];
}

export function insertRegistrySlots(db: Database, snapshot: RegistrySnapshot): void {
  db.prepare(
    `INSERT OR REPLACE INTO registry_snapshots
       (epoch_index, gateway_count, captured_at, captured_at_slot, registry_pubkey, digest, in_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.epochIndex,
    snapshot.gatewayCount,
    snapshot.capturedAt,
    snapshot.capturedAtSlot,
    snapshot.registryPubkey,
    snapshot.digest,
    snapshot.inEpoch ? 1 : 0
  );

  db.prepare('DELETE FROM registry_slots WHERE epoch_index = ?').run(snapshot.epochIndex);

  const insert = db.prepare(
    'INSERT INTO registry_slots (epoch_index, slot_index, gateway_address) VALUES (?, ?, ?)'
  );
  snapshot.slots.forEach((address, index) => {
    insert.run(snapshot.epochIndex, index, address);
  });
}

/**
 * Never /dev/null a decode failure — park the bytes and keep going.
 *
 * Deduped on `(pubkey, sha256(bytes))`: an account that is permanently
 * undecodable is re-read every cycle, and a plain INSERT would add ~630 bytes
 * of base64 every 10 minutes forever to the same file capture depends on.
 * A repeat bumps a counter instead.
 */
export function insertRawUnparsed(
  db: Database,
  pubkey: string,
  data: Buffer,
  reason: string,
  seenAt: number,
  seenSlot: number
): 'inserted' | 'repeated' {
  const digest = createHash('sha256').update(data).digest('hex');

  const existing = db
    .prepare<
      [string, string],
      { id: number }
    >('SELECT id FROM raw_unparsed WHERE pubkey = ? AND data_sha256 = ? LIMIT 1')
    .get(pubkey, digest);

  if (existing) {
    db.prepare(
      `UPDATE raw_unparsed SET seen_count = COALESCE(seen_count, 1) + 1, last_seen_at = ?,
         reason = ? WHERE id = ?`
    ).run(seenAt, reason, existing.id);
    return 'repeated';
  }

  db.prepare(
    `INSERT INTO raw_unparsed
       (pubkey, data_b64, byte_length, reason, seen_at, seen_slot, data_sha256, seen_count, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(pubkey, data.toString('base64'), data.length, reason, seenAt, seenSlot, digest, seenAt);
  return 'inserted';
}

/**
 * Drop poll-run rows older than `keepMs`. 144 rows/day accumulate forever
 * otherwise, in the same file the capture write path serialises on.
 */
export function prunePollRuns(db: Database, keepMs: number, now = Date.now()): number {
  const info = db
    .prepare(`DELETE FROM poll_runs WHERE started_at < ? AND status != 'running'`)
    .run(now - keepMs);
  return info.changes;
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
  /**
   * 'anomaly' is the one that matters: a cycle whose RPC call succeeded but
   * which captured nothing useful. Recording that as 'ok' is how a total
   * blackout gets a green light. See capture/status.ts.
   */
  status: 'ok' | 'failed' | 'stale' | 'anomaly';
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
  tookOverDead?: boolean;
}

/**
 * Single-instance guard.
 *
 * Refuses when a live heartbeat exists; takes over a lock whose heartbeat is
 * older than `staleAfterMs`, and — crucially — a lock left behind on THIS host
 * by a process that no longer exists. Without the liveness probe, any abnormal
 * exit (crash, OOM, SIGKILL, host reset) makes every supervisor restart refuse
 * for `staleAfterMs`, which at a 10-minute interval is half an hour with
 * capture down and epochs being swept off the chain.
 *
 * `holderIsDead` is injected so the check stays testable and so the DB layer
 * never reaches for `os`/`process` itself.
 */
export function acquirePollLock(
  db: Database,
  pid: number,
  host: string,
  staleAfterMs: number,
  holderIsDead?: (holder: { pid: number; host: string }) => boolean
) {
  const now = Date.now();
  let state: LockState = { acquired: false };

  const run = db.transaction(() => {
    const existing = db
      .prepare<
        [],
        { pid: number; host: string; heartbeat_at: number }
      >('SELECT pid, host, heartbeat_at FROM poll_lock WHERE id = 1')
      .get();

    const fresh = existing !== undefined && now - existing.heartbeat_at < staleAfterMs;
    const dead =
      existing !== undefined && holderIsDead
        ? holderIsDead({ pid: existing.pid, host: existing.host })
        : false;

    if (existing && fresh && !dead) {
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

    state = { acquired: true, tookOverStale: !!existing && !dead, tookOverDead: dead };
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

/**
 * Promote a calibration row.
 *
 * A run flagged `NO_SEPARATION` proved that blob similarity carries no
 * discriminating signal at this network size. Activating it would raise
 * `near_identical_results` from confidence 0.5 / capped `medium` to 0.9 /
 * possible `high` — i.e. publish strong accusations derived from a metric the
 * tool itself just measured as useless. Refuse unless the operator forces it.
 */
export function activateCalibration(
  db: Database,
  id: number,
  options: { force?: boolean } = {}
): { ok: true } | { ok: false; reason: 'not_found' | 'no_separation' } {
  const row = db
    .prepare<
      [number],
      { id: number; separates: number | null }
    >('SELECT id, separates FROM calibration WHERE id = ?')
    .get(id);

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.separates === 0 && !options.force) return { ok: false, reason: 'no_separation' };

  const run = db.transaction(() => {
    db.prepare('UPDATE calibration SET active = 0').run();
    db.prepare('UPDATE calibration SET active = 1 WHERE id = ?').run(id);
  });
  run.immediate();
  return { ok: true };
}
