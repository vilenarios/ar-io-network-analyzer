/**
 * Retain the protocol balance once per completed epoch.
 *
 * THE GAP THIS CLOSES. `protocolBalance` is computed on every publish cycle and
 * written to `portal/summary.json`, then the previous value is overwritten.
 * Because only one sample ever existed at a time, no delta could be taken, so
 * protocol revenue was not derivable at any point in time. Nothing new is
 * measured here — every input was already being computed. The missing
 * capability was retention.
 *
 * The identity this enables, for a consumer:
 *
 *     netInflow(t) = protocolBalance(t) − protocolBalance(t−1)
 *                    + totalEligibleRewards(t)
 *
 * FOUR RULES, each of which exists because breaking it corrupts the series
 * silently rather than loudly:
 *
 * 1. Never fabricate a row. If the balance cannot be read, the epoch is
 *    skipped entirely — no carry-forward, no interpolation, no zero. A gap is
 *    honest and a consumer can render it; a fabricated point poisons every
 *    delta that spans it, and nothing downstream can tell.
 *
 * 2. No backfill. Epochs that completed before the first real capture never
 *    appear — `epochsAwaitingEconomicsSample` will not return an epoch that
 *    ended more than one epoch ago, so the current balance can never be
 *    attributed to old history. The series legitimately starts empty and grows
 *    one row per epoch. Reconstructing a past balance from today's is exactly
 *    the fabrication rule 1 forbids, and without the window it happens
 *    automatically on first run.
 *
 * 3. Sample at a defined point, not "whenever the job ran". The balance moves
 *    continuously, so a row is only comparable to its neighbours if every row
 *    is taken at the same moment in the epoch lifecycle. That moment is the
 *    epoch boundary, once `epochs.rewards_distributed = 1` confirms the epoch's
 *    rewards have left the protocol balance.
 *
 *    "Whenever the job ran" is NOT that point, and the difference is not
 *    academic: the first row ever written landed 15.4 hours after its boundary
 *    and so absorbed 15.4 hours of the next epoch's activity — 35,725 ARIO.
 *    `readBoundaryBalance` resolves the balance AT the boundary from
 *    transaction metadata, which is exact, reproducible, and yields the same
 *    answer an hour or a year later. That last property is what lets rows
 *    written live and rows recovered afterwards belong to one series.
 *
 * 4. Components, not conclusions. `protocolBalance` and `totalEligibleRewards`
 *    are published; the subtraction is the consumer's. There is deliberately no
 *    field called `revenue`: the balance also moves for reasons that are not
 *    ArNS revenue, and naming a number that way would assert an attribution we
 *    cannot currently back.
 */

import type { Database } from 'better-sqlite3';
import {
  epochTotalEligibleRewards,
  epochsAwaitingEconomicsSample,
} from '../db/repo-read.js';
import { fetchArioPriceUsd } from './price.js';

/** The on-chain figures a sample needs, as the portal snapshot already has them. */
export interface EconomicsInputs {
  protocolBalance: number;
  circulating: number | null;
  staked: number | null;
  delegated: number | null;
  demandFactor: number | null;
  arnsRecordCount: number | null;
  /** Slot the balance was observed at, when the caller knows it. */
  slot?: number | null;
  /**
   * When the balance was actually observed on chain, unix ms.
   *
   * Preferred over "now": the reader may be surfacing a figure captured a few
   * minutes earlier, and the series should record when the number was true,
   * not when this job happened to look at it.
   */
  observedAt?: number;
}

export interface SampleResult {
  sampled: number[];
  skipped: number[];
}

/** Resolves the protocol balance as it stood at an epoch's boundary. */
export type BoundaryBalanceReader = (
  epochIndex: number
) => Promise<{ balance: number; slot: number; endMs: number } | null>;

/**
 * Write a sample for every distributed-but-unsampled epoch.
 *
 * `epoch_index` is the primary key and the insert is `OR IGNORE`, so this is
 * idempotent: a second run writes nothing. That is what keeps the series
 * append-only rather than "whatever the most recent run happened to observe".
 *
 * @param readInputs Resolves the current on-chain figures. Returning null means
 *   "could not read" and the epoch is skipped per rule 1 — it must NOT return
 *   stale or defaulted values.
 */
export async function sampleEconomics(
  db: Database,
  readInputs: () => Promise<EconomicsInputs | null>,
  options: {
    now?: number;
    fetchPrice?: typeof fetchArioPriceUsd;
    readBoundaryBalance?: BoundaryBalanceReader;
  } = {}
): Promise<SampleResult> {
  const pending = epochsAwaitingEconomicsSample(db, options.now ?? Date.now());
  if (pending.length === 0) return { sampled: [], skipped: [] };

  const inputs = await readInputs();
  if (!inputs || !Number.isFinite(inputs.protocolBalance)) {
    // Rule 1: skip rather than invent. These epochs stay pending and are
    // retried on the next run, which is harmless — the balance is still live.
    return { sampled: [], skipped: pending };
  }

  // Rule 4's companion: the price is optional and must never gate the row.
  const fetchPrice = options.fetchPrice ?? fetchArioPriceUsd;
  const price = await fetchPrice();

  // The observation time, when the reader knows it — see EconomicsInputs.
  const now = inputs.observedAt ?? options.now ?? Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO economics_samples (
       epoch_index, sampled_at, slot, protocol_balance, total_eligible_rewards,
       demand_factor, circulating, staked, delegated, arns_record_count,
       ario_price_usd, ario_price_source, ario_price_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Rule 3: prefer the balance AT the boundary over the balance now. Resolved
  // per epoch before the write, because it is async and the write is not.
  const boundaries = new Map<number, { balance: number; slot: number; endMs: number }>();
  if (options.readBoundaryBalance) {
    for (const epochIndex of pending) {
      const boundary = await options.readBoundaryBalance(epochIndex);
      if (boundary) boundaries.set(epochIndex, boundary);
    }
  }

  const sampled: number[] = [];
  const write = db.transaction((epochIndexes: number[]) => {
    for (const epochIndex of epochIndexes) {
      // No boundary means the recovery failed (RPC down, or history pruned).
      // Falling back to the current balance keeps the row rather than losing
      // the epoch, and stays honest: `sampled_at` then holds the sampling time
      // instead of the boundary, so a consumer can see which anchor was used.
      const boundary = boundaries.get(epochIndex);
      insert.run(
        epochIndex,
        boundary?.endMs ?? now,
        boundary?.slot ?? inputs.slot ?? null,
        boundary?.balance ?? inputs.protocolBalance,
        epochTotalEligibleRewards(db, epochIndex),
        inputs.demandFactor,
        inputs.circulating,
        inputs.staked,
        inputs.delegated,
        inputs.arnsRecordCount,
        price?.usd ?? null,
        price?.source ?? null,
        price?.observedAt ?? null
      );
      sampled.push(epochIndex);
    }
  });
  write(pending);

  return { sampled, skipped: [] };
}
