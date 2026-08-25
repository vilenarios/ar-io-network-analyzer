/**
 * Retain every staking position once per settled epoch.
 *
 * Earnings are a difference between two observations. Nothing on chain records
 * what a position has EARNED — only what it currently holds — because rewards
 * compound directly into stake. So without retention there is only ever one
 * observation and the difference is undefined.
 *
 * THE RULE THAT DIFFERS FROM THE ECONOMICS SERIES. A protocol balance at a past
 * epoch is recoverable from `postTokenBalances`, so that series could be
 * backfilled. A stake at a past epoch cannot: `DistributeEpoch` credits
 * positions in PDA state, and PDA state has no per-transaction history. Every
 * epoch that passes unsampled is lost permanently. That asymmetry is the whole
 * reason this exists, and it is why sampling runs on the cheap 10-minute
 * cadence rather than waiting for a tidier design.
 *
 * WHAT A ROW IS AND IS NOT. A row records the stake a position held shortly
 * after an epoch distributed. It is NOT anchored to the epoch boundary the way
 * an economics row is — that would require reading historical state, which is
 * the thing that is impossible. `sampled_at` records when the portal actually
 * observed it, so a consumer can see the offset instead of assuming there is
 * none.
 *
 * AND A DELTA IS NOT YET EARNINGS. Stake also moves when someone stakes more or
 * withdraws. Those are ordinary transactions and remain recoverable from chain
 * history at any time, so attributing them is deliberately deferred — it can be
 * backfilled later, and this cannot. Until then a consumer sees `stakeChange`,
 * never `rewards`.
 */

import type { Database } from 'better-sqlite3';
import type { StakeSnapshot } from './inputs.js';

export interface StakeSampleResult {
  sampled: number[];
  skipped: number[];
  positions: number;
}

/**
 * Epochs that have distributed but have no stake sample yet.
 *
 * ONE EPOCH, NOT SEVERAL, and the first implementation got this wrong: a 48h
 * window sampled epochs 522 and 523 together and wrote the SAME observed stake
 * to both. That makes the 522->523 delta exactly zero, which reads as "this
 * position earned nothing" and is indistinguishable from the truth downstream.
 *
 * It is the same fabrication the economics sampler forbids, and the temptation
 * here is stronger precisely because stake cannot be backfilled — the instinct
 * is to salvage the older epoch. But an unrecoverable gap is honest and a
 * consumer can render it; a fabricated zero silently corrupts every figure
 * derived across it. So the window is one epoch, and a genuinely missed epoch
 * stays missed.
 */
const MAX_SAMPLE_LAG_MS = 24 * 60 * 60 * 1000;

export function epochsAwaitingStakeSample(
  db: Database,
  now: number = Date.now(),
  limit = 1
): number[] {
  return db
    .prepare<[number, number], { epoch_index: number }>(
      `SELECT e.epoch_index
         FROM epochs e
         LEFT JOIN stake_samples s ON s.epoch_index = e.epoch_index
        WHERE e.rewards_distributed = 1
          AND s.epoch_index IS NULL
          AND e.end_timestamp IS NOT NULL
          AND e.end_timestamp >= ?
        ORDER BY e.epoch_index ASC
        LIMIT ?`
    )
    .all(Math.floor((now - MAX_SAMPLE_LAG_MS) / 1000), limit)
    .map((row) => row.epoch_index);
}

/**
 * Write one row per position for every distributed-but-unsampled epoch.
 *
 * `INSERT OR IGNORE` on the composite key, so re-running is a no-op and the
 * series stays append-only rather than "whatever the last run observed".
 */
export async function sampleStakePositions(
  db: Database,
  readSnapshot: () => Promise<StakeSnapshot | null>,
  options: { now?: number } = {}
): Promise<StakeSampleResult> {
  const now = options.now ?? Date.now();
  const pending = epochsAwaitingStakeSample(db, now);
  if (pending.length === 0) return { sampled: [], skipped: [], positions: 0 };

  const snapshot = await readSnapshot();
  if (!snapshot || snapshot.positions.length === 0) {
    // Skip rather than invent. These epochs stay pending and retry on the next
    // 10-minute cycle, which is why a brief publisher outage costs nothing.
    return { sampled: [], skipped: pending, positions: 0 };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO stake_samples (
       epoch_index, kind, address, gateway_address, staked, vaulted,
       start_timestamp, sampled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let positions = 0;
  const write = db.transaction((epochIndexes: number[]) => {
    for (const epochIndex of epochIndexes) {
      for (const position of snapshot.positions) {
        insert.run(
          epochIndex,
          position.kind,
          position.address,
          position.gatewayAddress,
          position.staked,
          position.vaulted,
          position.startTimestamp,
          snapshot.observedAt
        );
        positions++;
      }
    }
  });
  write(pending);

  return { sampled: pending, skipped: [], positions };
}
