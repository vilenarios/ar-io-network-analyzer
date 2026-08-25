/**
 * `/api/v1/economics.json` — the retained protocol-economics series.
 *
 * One row per completed epoch, oldest first, append-only. Amounts in mARIO,
 * matching every other document; `demandFactor` unscaled, as in
 * `portal/summary.json`.
 *
 * Deliberately absent: a `revenue` field, or any other derived figure. The
 * document publishes `protocolBalance` and `totalEligibleRewards` and lets the
 * consumer take the difference, because the balance also moves for reasons that
 * are not ArNS revenue. Naming a derived number "revenue" here would assert an
 * attribution nothing in this pipeline can currently back — the portal is
 * expected to label it "net protocol inflow" for the same reason. If inflows
 * ever become attributable by source, publish them as separate named
 * components rather than collapsing them into one figure.
 *
 * The earliest row has no predecessor, so any delta a consumer derives from it
 * is undefined — null, never zero. This document does not compute deltas at
 * all, which is the simplest way to avoid getting that wrong.
 */

import type { EconomicsSample } from '../db/repo-read.js';

export const ECONOMICS_SCHEMA_VERSION = '1.0';

export interface EconomicsRow {
  epochIndex: number;
  /** Epoch end, unix MILLISECONDS. The store keeps seconds; converted here. */
  endTimestamp: number | null;
  /** Slot the balance was observed at, when known. */
  slot: number | null;
  protocolBalance: number;
  totalEligibleRewards: number | null;
  demandFactor: number | null;
  circulating: number | null;
  staked: number | null;
  delegated: number | null;
  arnsRecordCount: number | null;
  /** Off-chain, independently nullable. See `arioPriceSource`. */
  arioPriceUsd: number | null;
  arioPriceSource: string | null;
  arioPriceAt: number | null;
}

export interface EconomicsDocument {
  schemaVersion: string;
  generatedAt: string;
  series: EconomicsRow[];
}

/**
 * Build the document from retained samples.
 *
 * An empty series is a valid, correct document. The series starts empty by
 * design — see the no-backfill rule in `sample.ts` — and a consumer that
 * cannot handle `series: []` is the thing that is wrong.
 *
 * @param endTimestampSeconds Resolves an epoch's end time from the store, in
 *   seconds. Null when unknown; the row is still published, because the epoch
 *   index alone orders the series.
 */
export function buildEconomicsDocument(
  samples: EconomicsSample[],
  endTimestampSeconds: (epochIndex: number) => number | null,
  generatedAt: string
): EconomicsDocument {
  return {
    schemaVersion: ECONOMICS_SCHEMA_VERSION,
    generatedAt,
    series: samples
      .slice()
      .sort((a, b) => a.epochIndex - b.epochIndex)
      .map((sample) => {
        const seconds = endTimestampSeconds(sample.epochIndex);
        return {
          epochIndex: sample.epochIndex,
          // The store keeps `end_timestamp` in SECONDS. Publishing it raw would
          // put every timestamp in 1970 for anyone doing `new Date(value)`.
          endTimestamp: seconds === null ? null : seconds * 1000,
          slot: sample.slot,
          protocolBalance: sample.protocolBalance,
          totalEligibleRewards: sample.totalEligibleRewards,
          demandFactor: sample.demandFactor,
          circulating: sample.circulating,
          staked: sample.staked,
          delegated: sample.delegated,
          arnsRecordCount: sample.arnsRecordCount,
          arioPriceUsd: sample.arioPriceUsd,
          arioPriceSource: sample.arioPriceSource,
          arioPriceAt: sample.arioPriceAt,
        };
      }),
  };
}
