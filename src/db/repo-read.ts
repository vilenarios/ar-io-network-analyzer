/**
 * Read side of the observation store, plus the derived-findings writes.
 *
 * `findings` / `finding_observers` are fully recomputable, so they are safe to
 * delete and regenerate; they are owned by the analysis cadence, not capture.
 */

import type { Database } from 'better-sqlite3';
import type {
  EpochSnapshot,
  Finding,
  ObservationRecord,
  RegistrySnapshot,
  Severity,
  StoredFinding,
} from '../observers/types.js';

interface ObservationRow {
  epoch_index: number;
  observer: string;
  pubkey: string;
  gateway_results: Buffer;
  gateway_count: number;
  report_tx_id: string;
  submitted_at: number;
  schema_major: number | null;
  schema_minor: number | null;
  schema_patch: number | null;
  account_bytes: number;
  suspect_timestamp: number;
  revision: number;
  first_seen_at: number;
  last_seen_at: number;
  first_seen_slot: number;
  last_seen_slot: number;
}

function toObservation(row: ObservationRow): ObservationRecord {
  return {
    epochIndex: row.epoch_index,
    observer: row.observer,
    pubkey: row.pubkey,
    gatewayResults: Buffer.from(row.gateway_results),
    gatewayCount: row.gateway_count,
    reportTxId: row.report_tx_id,
    submittedAt: row.submitted_at,
    schemaVersion:
      row.schema_major === null
        ? null
        : {
            major: row.schema_major,
            minor: row.schema_minor ?? 0,
            patch: row.schema_patch ?? 0,
          },
    accountBytes: row.account_bytes,
    suspectTimestamp: row.suspect_timestamp === 1,
    revision: row.revision,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    firstSeenSlot: row.first_seen_slot,
    lastSeenSlot: row.last_seen_slot,
  };
}

export interface EpochListEntry {
  epochIndex: number;
  observationCount: number;
  distinctReportTxIds: number;
  firstSubmittedAtUnix: number;
  lastSubmittedAtUnix: number;
  registryCaptured: boolean;
}

/** Every epoch we hold observations for, ascending. */
export function listEpochs(db: Database): EpochListEntry[] {
  const rows = db
    .prepare<
      [],
      {
        epoch_index: number;
        n: number;
        distinct_reports: number;
        first_submitted: number;
        last_submitted: number;
        registry: number;
      }
    >(
      `SELECT o.epoch_index,
              COUNT(*) AS n,
              COUNT(DISTINCT o.report_tx_id) AS distinct_reports,
              MIN(o.submitted_at) AS first_submitted,
              MAX(o.submitted_at) AS last_submitted,
              (SELECT COUNT(*) FROM registry_snapshots r WHERE r.epoch_index = o.epoch_index) AS registry
         FROM observations o
        GROUP BY o.epoch_index
        ORDER BY o.epoch_index ASC`
    )
    .all();

  return rows.map((r) => ({
    epochIndex: r.epoch_index,
    observationCount: r.n,
    distinctReportTxIds: r.distinct_reports,
    firstSubmittedAtUnix: r.first_submitted,
    lastSubmittedAtUnix: r.last_submitted,
    registryCaptured: r.registry > 0,
  }));
}

export function getRegistrySnapshot(db: Database, epochIndex: number): RegistrySnapshot | null {
  const meta = db
    .prepare<
      [number],
      {
        epoch_index: number;
        gateway_count: number;
        captured_at: number;
        captured_at_slot: number;
        registry_pubkey: string;
        digest: string;
      }
    >(`SELECT * FROM registry_snapshots WHERE epoch_index = ?`)
    .get(epochIndex);
  if (!meta) return null;

  const slots = db
    .prepare<[number], { gateway_address: string }>(
      'SELECT gateway_address FROM registry_slots WHERE epoch_index = ? ORDER BY slot_index ASC'
    )
    .all(epochIndex)
    .map((r) => r.gateway_address);

  return {
    epochIndex: meta.epoch_index,
    gatewayCount: meta.gateway_count,
    capturedAt: meta.captured_at,
    capturedAtSlot: meta.captured_at_slot,
    registryPubkey: meta.registry_pubkey,
    digest: meta.digest,
    slots,
  };
}

/** One epoch, fully hydrated. Returns null when nothing was captured for it. */
export function getEpoch(db: Database, epochIndex: number): EpochSnapshot | null {
  const observations = db
    .prepare<
      [number],
      ObservationRow
    >('SELECT * FROM observations WHERE epoch_index = ? ORDER BY observer ASC')
    .all(epochIndex)
    .map(toObservation);

  if (observations.length === 0) return null;

  const submitted = observations.map((o) => o.submittedAt);
  return {
    epochIndex,
    observations,
    distinctReportTxIds: new Set(observations.map((o) => o.reportTxId)).size,
    firstSubmittedAtUnix: Math.min(...submitted),
    lastSubmittedAtUnix: Math.max(...submitted),
    registry: getRegistrySnapshot(db, epochIndex),
  };
}

/** Hydrate a set of epochs, ascending. Missing epochs are skipped. */
export function getObservationsForEpochs(db: Database, epochIndexes: number[]): EpochSnapshot[] {
  const snapshots: EpochSnapshot[] = [];
  for (const epochIndex of [...epochIndexes].sort((a, b) => a - b)) {
    const snapshot = getEpoch(db, epochIndex);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

export interface PollRunSummary {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  accountCount: number | null;
  contextSlot: number | null;
  error: string | null;
  durationMs: number | null;
}

export function latestPollRun(db: Database): PollRunSummary | null {
  const row = db
    .prepare<
      [],
      {
        id: number;
        started_at: number;
        finished_at: number | null;
        status: string;
        account_count: number | null;
        context_slot: number | null;
        error: string | null;
        duration_ms: number | null;
      }
    >(`SELECT * FROM poll_runs ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get();
  if (!row) return null;

  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    accountCount: row.account_count,
    contextSlot: row.context_slot,
    error: row.error,
    durationMs: row.duration_ms,
  };
}

/** How many completed runs in a row failed, counting back from the newest. */
export function consecutiveFailedPollRuns(db: Database): number {
  const rows = db
    .prepare<
      [],
      { status: string }
    >(`SELECT status FROM poll_runs WHERE status != 'running' ORDER BY started_at DESC, id DESC LIMIT 50`)
    .all();

  let count = 0;
  for (const row of rows) {
    if (row.status === 'failed') count++;
    else break;
  }
  return count;
}

export interface AnalysisRunSummary {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  gatewayCount: number | null;
}

export function latestAnalysisRun(db: Database): AnalysisRunSummary | null {
  const row = db
    .prepare<
      [],
      {
        id: number;
        started_at: number;
        finished_at: number | null;
        status: string;
        gateway_count: number | null;
      }
    >(`SELECT * FROM analysis_runs ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    gatewayCount: row.gateway_count,
  };
}

/**
 * Replace the findings for a set of epochs.
 *
 * Ids are deterministic, so re-running an epoch produces byte-identical ids;
 * `first_seen_at` is preserved across recomputes.
 */
export function upsertFindings(
  db: Database,
  findings: Finding[],
  detectorVersion: number,
  scopeEpochIndexes: number[],
  includeCrossEpoch: boolean
): void {
  const now = Date.now();

  const run = db.transaction(() => {
    const previous = new Map<string, number>(
      db
        .prepare<[], { id: string; first_seen_at: number }>(
          'SELECT id, first_seen_at FROM findings'
        )
        .all()
        .map((r) => [r.id, r.first_seen_at])
    );

    // Drop stale rows in the recomputed scope. Derived data is safe to delete.
    const deleteEpoch = db.prepare('DELETE FROM findings WHERE epoch_index = ?');
    for (const epochIndex of scopeEpochIndexes) deleteEpoch.run(epochIndex);
    if (includeCrossEpoch) db.prepare('DELETE FROM findings WHERE epoch_index IS NULL').run();

    const insertFinding = db.prepare(
      `INSERT INTO findings (
         id, kind, epoch_index, severity, confidence, observer_count, summary,
         detail_json, detected_at, first_seen_at, detector_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, epoch_index = excluded.epoch_index, severity = excluded.severity,
         confidence = excluded.confidence, observer_count = excluded.observer_count,
         summary = excluded.summary, detail_json = excluded.detail_json,
         detected_at = excluded.detected_at, detector_version = excluded.detector_version`
    );
    const insertObserver = db.prepare(
      'INSERT OR IGNORE INTO finding_observers (finding_id, observer) VALUES (?, ?)'
    );

    for (const finding of findings) {
      insertFinding.run(
        finding.id,
        finding.kind,
        finding.epochIndex,
        finding.severity,
        finding.confidence,
        finding.observers.length,
        finding.summary,
        JSON.stringify(finding.detail),
        now,
        previous.get(finding.id) ?? now,
        detectorVersion
      );
      for (const observer of finding.observers) insertObserver.run(finding.id, observer);
    }

    // finding_observers rows for findings that no longer exist.
    db.prepare(
      'DELETE FROM finding_observers WHERE finding_id NOT IN (SELECT id FROM findings)'
    ).run();
  });

  run.immediate();
}

export interface ListFindingsOptions {
  epochIndexes?: number[];
  includeCrossEpoch?: boolean;
  limit?: number;
}

export function listFindings(db: Database, options: ListFindingsOptions = {}): StoredFinding[] {
  const clauses: string[] = [];
  const params: Array<number> = [];

  if (options.epochIndexes && options.epochIndexes.length > 0) {
    const placeholders = options.epochIndexes.map(() => '?').join(', ');
    clauses.push(
      options.includeCrossEpoch === false
        ? `epoch_index IN (${placeholders})`
        : `(epoch_index IN (${placeholders}) OR epoch_index IS NULL)`
    );
    params.push(...options.epochIndexes);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';

  const rows = db
    .prepare<
      number[],
      {
        id: string;
        kind: string;
        epoch_index: number | null;
        severity: string;
        confidence: number;
        summary: string;
        detail_json: string;
        detected_at: number;
        first_seen_at: number;
        detector_version: number;
      }
    >(
      // Severity is not ordered here — it is a word, not a rank. Callers that
      // care rank it in JS via SEVERITY_ORDER.
      `SELECT * FROM findings ${where}
        ORDER BY (epoch_index IS NULL) DESC, epoch_index DESC, confidence DESC ${limit}`
    )
    .all(...params);

  const observersById = new Map<string, string[]>();
  for (const row of db
    .prepare<
      [],
      { finding_id: string; observer: string }
    >('SELECT finding_id, observer FROM finding_observers ORDER BY observer ASC')
    .all()) {
    const list = observersById.get(row.finding_id) ?? [];
    list.push(row.observer);
    observersById.set(row.finding_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as StoredFinding['kind'],
    epochIndex: row.epoch_index,
    observers: observersById.get(row.id) ?? [],
    severity: row.severity as Severity,
    confidence: row.confidence,
    detectedAt: new Date(row.detected_at).toISOString(),
    summary: row.summary,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    firstSeenAt: row.first_seen_at,
    detectorVersion: row.detector_version,
  }));
}

export interface CalibrationRow {
  id: number;
  computedAt: number;
  epochFrom: number;
  epochTo: number;
  epochCount: number;
  pairCount: number;
  independentPairs: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  p995: number | null;
  p999: number | null;
  maxIndependent: number | null;
  recommendedThreshold: number;
  active: boolean;
  notes: string | null;
}

export function activeCalibration(db: Database): CalibrationRow | null {
  const row = db
    .prepare<
      [],
      Record<string, number | string | null>
    >('SELECT * FROM calibration WHERE active = 1 ORDER BY id DESC LIMIT 1')
    .get();
  if (!row) return null;

  return {
    id: Number(row.id),
    computedAt: Number(row.computed_at),
    epochFrom: Number(row.epoch_from),
    epochTo: Number(row.epoch_to),
    epochCount: Number(row.epoch_count),
    pairCount: Number(row.pair_count),
    independentPairs: Number(row.independent_pairs),
    p50: row.p50 === null ? null : Number(row.p50),
    p90: row.p90 === null ? null : Number(row.p90),
    p99: row.p99 === null ? null : Number(row.p99),
    p995: row.p995 === null ? null : Number(row.p995),
    p999: row.p999 === null ? null : Number(row.p999),
    maxIndependent: row.max_independent === null ? null : Number(row.max_independent),
    recommendedThreshold: Number(row.recommended_threshold),
    active: Number(row.active) === 1,
    notes: (row.notes as string | null) ?? null,
  };
}
