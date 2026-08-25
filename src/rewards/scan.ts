/**
 * Attribute delegate reward events to the epoch that earned them.
 *
 * Rewards for epoch N are compounded shortly AFTER N's boundary — the events
 * observed at 00:41 follow a boundary at 00:04 — so an event belongs to the
 * most recent epoch that had already ended when it fired. Assigning by "the
 * epoch containing this timestamp" would shift every reward one epoch forward.
 *
 * Scanning is replayable. Unlike a stake sample, which is an observation lost
 * forever if missed, these events sit in transaction logs and can be re-derived
 * at any time — so this is safe to re-run, safe to interrupt, and safe to
 * backfill years later.
 */

import type { Database } from 'better-sqlite3';
import { decodeRewardEvents, type DelegateRewardEvent } from './events.js';

/** The ARIO program, whose transactions carry the reward events. */
export const ARIO_PROGRAM_ID =
  process.env.ARIO_PROGRAM_ID || '89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf';

export interface ScanTransaction {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

export interface ScanDeps {
  /** Program signatures, newest first, back to at least `sinceSeconds`. */
  listSignatures: (sinceSeconds: number) => Promise<ScanTransaction[]>;
  /** Log messages for a transaction, or null when unavailable. */
  logsFor: (signature: string) => Promise<readonly string[] | null>;
}

export interface ScanResult {
  /** Epochs whose rewards were recorded. */
  epochs: number[];
  events: number;
  transactions: number;
  totalAmount: number;
}

interface EpochBoundary {
  epochIndex: number;
  endSeconds: number;
}

/**
 * Resolve which epoch a reward event belongs to.
 *
 * Exported because the off-by-one it prevents is worth testing directly.
 */
export function epochForRewardAt(boundaries: readonly EpochBoundary[], at: number): number | null {
  let match: number | null = null;
  for (const boundary of boundaries) {
    if (boundary.endSeconds <= at) match = boundary.epochIndex;
    else break;
  }
  return match;
}

/**
 * Scan for reward events and record them per (epoch, delegate, gateway).
 *
 * @param epochIndexes Epochs to record. Events outside them are ignored, so a
 *   scan cannot half-fill an epoch it was not asked about — a partially scanned
 *   epoch would read as "earned less" with nothing to indicate otherwise.
 */
export async function scanDelegateRewards(
  db: Database,
  deps: ScanDeps,
  epochIndexes: readonly number[],
  options: { now?: number } = {}
): Promise<ScanResult> {
  const now = options.now ?? Date.now();
  if (epochIndexes.length === 0) {
    return { epochs: [], events: 0, transactions: 0, totalAmount: 0 };
  }

  const boundaries = db
    .prepare<[], EpochBoundary>(
      `SELECT epoch_index AS epochIndex, end_timestamp AS endSeconds
         FROM epochs
        WHERE end_timestamp IS NOT NULL
        ORDER BY epoch_index ASC`
    )
    .all();

  const wanted = new Set(epochIndexes);
  const earliest = boundaries
    .filter((b) => wanted.has(b.epochIndex))
    .reduce((min, b) => Math.min(min, b.endSeconds), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(earliest)) {
    return { epochs: [], events: 0, transactions: 0, totalAmount: 0 };
  }

  const signatures = (await deps.listSignatures(earliest))
    // A failed transaction credited nothing, whatever it logged.
    .filter((entry) => entry.err === null && entry.blockTime !== null)
    .filter((entry) => Number(entry.blockTime) >= earliest);

  // Aggregated per (epoch, delegate, gateway): one delegation can be credited
  // several times in an epoch, and the total is what a holder cares about.
  const totals = new Map<
    string,
    { epochIndex: number; event: DelegateRewardEvent; amount: number; count: number; firstAt: number; lastAt: number }
  >();
  let events = 0;
  let transactions = 0;
  let totalAmount = 0;

  for (const entry of signatures) {
    const logs = await deps.logsFor(entry.signature);
    if (!logs) continue;
    transactions++;

    for (const event of decodeRewardEvents(logs)) {
      const epochIndex = epochForRewardAt(boundaries, event.at);
      if (epochIndex === null || !wanted.has(epochIndex)) continue;

      const key = `${epochIndex}|${event.delegate}|${event.gateway}`;
      const existing = totals.get(key);
      if (existing) {
        existing.amount += event.amount;
        existing.count++;
        existing.firstAt = Math.min(existing.firstAt, event.at);
        existing.lastAt = Math.max(existing.lastAt, event.at);
      } else {
        totals.set(key, {
          epochIndex,
          event,
          amount: event.amount,
          count: 1,
          firstAt: event.at,
          lastAt: event.at,
        });
      }
      events++;
      totalAmount += event.amount;
    }
  }

  const upsert = db.prepare(
    // REPLACE, not IGNORE: a rescan of the same epoch recomputes the same
    // totals from the same immutable logs, so replacing is idempotent. Ignoring
    // would instead freeze a partial result from an interrupted scan.
    `INSERT OR REPLACE INTO delegate_rewards
       (epoch_index, delegate, gateway, amount, event_count, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const markScanned = db.prepare(
    `INSERT OR REPLACE INTO delegate_reward_scans
       (epoch_index, scanned_at, events, transactions) VALUES (?, ?, ?, ?)`
  );

  const scanned = new Set<number>();
  db.transaction(() => {
    for (const row of totals.values()) {
      upsert.run(
        row.epochIndex,
        row.event.delegate,
        row.event.gateway,
        row.amount,
        row.count,
        row.firstAt,
        row.lastAt
      );
      scanned.add(row.epochIndex);
    }
    // Mark every requested epoch, including those with no events: "scanned and
    // found nothing" and "never scanned" must not look the same.
    for (const epochIndex of epochIndexes) {
      const perEpoch = [...totals.values()].filter((r) => r.epochIndex === epochIndex);
      markScanned.run(
        epochIndex,
        now,
        perEpoch.reduce((sum, r) => sum + r.count, 0),
        transactions
      );
    }
  })();

  return {
    epochs: [...epochIndexes].sort((a, b) => a - b),
    events,
    transactions,
    totalAmount,
  };
}

/** Epochs that have distributed but have never been scanned for rewards. */
export function epochsAwaitingRewardScan(db: Database, limit = 40): number[] {
  return db
    .prepare<[number], { epoch_index: number }>(
      `SELECT e.epoch_index
         FROM epochs e
         LEFT JOIN delegate_reward_scans s ON s.epoch_index = e.epoch_index
        WHERE e.rewards_distributed = 1
          AND e.end_timestamp IS NOT NULL
          AND s.epoch_index IS NULL
        ORDER BY e.epoch_index ASC
        LIMIT ?`
    )
    .all(limit)
    .map((row) => row.epoch_index);
}
