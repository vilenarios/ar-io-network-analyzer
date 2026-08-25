/**
 * One-shot historical recovery for the economics series.
 *
 * This is NOT the "backfill" the live sampler refuses to do. That rule forbids
 * propagating one observed balance backwards over epochs it was never measured
 * at — inventing a flat series. This reads the actual historical value for each
 * epoch out of the chain's own record, which is a measurement, not a guess.
 *
 * HOW THE BALANCE IS RECOVERED. Solana transaction metadata carries
 * `postTokenBalances`, so the most recent transaction that changed the protocol
 * token account before an epoch boundary holds the exact balance at that
 * boundary. Three details make the difference between right and plausible:
 *
 *   1. Failed transactions appear in `getSignaturesForAddress` (9.2% of this
 *      account's history) and record no balance change. Skip them.
 *   2. Not every successful transaction that MENTIONS the account changes it —
 *      those carry no balance entry either. Taking "the last transaction before
 *      the boundary" therefore yields nothing for some epochs.
 *   3. Walking back to the last transaction that DID carry a balance is exact,
 *      not a fallback: if no later transaction changed the balance, that value
 *      is still the balance at the boundary, by definition.
 *
 * WHAT CANNOT BE RECOVERED, and is therefore left null rather than filled from
 * today's values: `demandFactor`, `circulating`, `staked`, `delegated` and
 * `arnsRecordCount`. Those live in PDAs whose historical state is not in
 * transaction metadata. A backfilled row is honest about being partial.
 *
 * Conversely a backfilled row has something live rows do not: a real `slot`,
 * because the recovering transaction pins the exact moment.
 */

import type { Database } from 'better-sqlite3';
import { epochTotalEligibleRewards } from '../db/repo-read.js';
import { recoverBoundaryBalance, usableSignatures, type SignatureRef } from './boundary.js';

export type { SignatureRef };

export interface BackfillDeps {
  /** All signatures touching the protocol token account, any order. */
  listSignatures: () => Promise<SignatureRef[]>;
  /** Post-transaction balance of the protocol account, or null if unchanged there. */
  balanceAfter: (signature: string) => Promise<number | null>;
  /** Daily close price for a UTC date, or null. */
  priceForCloseDate: (closeDate: string) => number | null;
  priceSource: string;
}

export interface BackfillResult {
  recovered: number[];
  /** Epochs whose existing row was re-derived at the boundary. See `reanchor`. */
  reanchored: number[];
  /** Per recovered epoch, what was (or would be) written. */
  rows: Array<{
    epochIndex: number;
    protocolBalance: number;
    slot: number | null;
    priceCloseDate: string;
    arioPriceUsd: number | null;
  }>;
  /** Epochs whose balance could not be recovered — published as gaps. */
  unrecoverable: number[];
  transactionsRead: number;
}

/**
 * The UTC date whose CLOSE price applies to an epoch ending at `endMs`.
 *
 * A daily close for date D lands at 00:00 on D+1, so for ANY moment on date D
 * the most recent completed close is D-1's — subtracting 24h picks that out
 * regardless of the time of day an epoch happens to end. Using the epoch's own
 * date would shift every figure forward one day, worth up to 23% on a single
 * row of this series: an error, not a rounding.
 */
export function priceCloseDateForEpochEnd(endMs: number): string {
  return new Date(endMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function backfillEconomics(
  db: Database,
  deps: BackfillDeps,
  options: { dryRun?: boolean; reanchor?: boolean } = {}
): Promise<BackfillResult> {
  const reanchored: number[] = [];

  const epochs = db
    .prepare<[number], { epoch_index: number; end_timestamp: number; reanchor: number }>(
      // Two populations in one pass, ordered together so the report reads as
      // one series: epochs with no row at all, and — only when explicitly
      // requested — epochs whose row was written under the old "sample whenever
      // the job ran" anchor and so is not comparable to its neighbours.
      `SELECT e.epoch_index, e.end_timestamp, 0 AS reanchor
         FROM epochs e
         LEFT JOIN economics_samples s ON s.epoch_index = e.epoch_index
        WHERE e.rewards_distributed = 1
          AND s.epoch_index IS NULL
          AND e.end_timestamp IS NOT NULL
        UNION ALL
       SELECT e.epoch_index, e.end_timestamp, 1 AS reanchor
         FROM epochs e
         JOIN economics_samples s ON s.epoch_index = e.epoch_index
        WHERE ? = 1
          AND e.end_timestamp IS NOT NULL
          AND s.sampled_at <> e.end_timestamp * 1000
        ORDER BY 1 ASC`
    )
    .all(options.reanchor ? 1 : 0);

  if (epochs.length === 0) {
    return { recovered: [], reanchored: [], rows: [], unrecoverable: [], transactionsRead: 0 };
  }

  const signatures = usableSignatures(await deps.listSignatures());

  const balanceCache = new Map<string, number | null>();
  const balanceAfter = async (signature: string) => {
    if (!balanceCache.has(signature)) {
      balanceCache.set(signature, await deps.balanceAfter(signature));
    }
    return balanceCache.get(signature) ?? null;
  };

  // OR IGNORE for new epochs is what keeps the series append-only. A re-anchor
  // is the one sanctioned exception and must therefore REPLACE, so it is a
  // separate statement rather than a looser one used for both.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO economics_samples (
       epoch_index, sampled_at, slot, protocol_balance, total_eligible_rewards,
       demand_factor, circulating, staked, delegated, arns_record_count,
       ario_price_usd, ario_price_source, ario_price_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
  );

  const replace = db.prepare(
    `INSERT OR REPLACE INTO economics_samples (
       epoch_index, sampled_at, slot, protocol_balance, total_eligible_rewards,
       demand_factor, circulating, staked, delegated, arns_record_count,
       ario_price_usd, ario_price_source, ario_price_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
  );

  const recovered: number[] = [];
  const rows: BackfillResult['rows'] = [];
  const unrecoverable: number[] = [];
  let transactionsRead = 0;

  for (const epoch of epochs) {
    const endSeconds = Number(epoch.end_timestamp);
    const endMs = endSeconds * 1000;

    const boundary = await recoverBoundaryBalance(signatures, endSeconds, balanceAfter);
    transactionsRead += boundary.transactionsRead;
    const { balance, slot } = boundary;

    if (balance === null) {
      // Honest gap. Never a carry-forward, never a zero.
      unrecoverable.push(epoch.epoch_index);
      continue;
    }

    const closeDate = priceCloseDateForEpochEnd(endMs);
    const price = deps.priceForCloseDate(closeDate);

    if (!options.dryRun) (epoch.reanchor ? replace : insert).run(
      epoch.epoch_index,
      // The balance was true at the epoch boundary, so that is what the row
      // records — not when this recovery happened to run.
      endMs,
      slot,
      balance,
      epochTotalEligibleRewards(db, epoch.epoch_index),
      price ?? null,
      price === null ? null : deps.priceSource,
      price === null ? null : Date.parse(`${closeDate}T00:00:00.000Z`)
    );
    if (epoch.reanchor) reanchored.push(epoch.epoch_index);
    else recovered.push(epoch.epoch_index);
    rows.push({
      epochIndex: epoch.epoch_index,
      protocolBalance: balance,
      slot,
      priceCloseDate: closeDate,
      arioPriceUsd: price,
    });
  }

  return { recovered, reanchored, rows, unrecoverable, transactionsRead };
}
