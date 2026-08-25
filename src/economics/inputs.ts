/**
 * Where an economics sample gets its on-chain figures.
 *
 * Every field is already computed and written to `portal/summary.json` by the
 * portal publisher every 10 minutes, so this reads that document off disk
 * rather than re-querying the chain. That is not just a saving: recomputing
 * `arnsRecordCount` alone costs a whole-program ArNS scan, which would make
 * sampling far more expensive than the thing it samples.
 *
 * It also gives a better timestamp. `summary.generatedAt` is the moment the
 * balance was actually observed on chain; `Date.now()` at sampling time is
 * merely when this job noticed. The series records the former.
 *
 * RULE 1 IS ENFORCED HERE. If the summary is missing, unparseable, or older
 * than `MAX_SUMMARY_AGE_MS`, this returns null and the caller skips the epoch.
 * It never falls back to a previous value, a default, or a zero — a stale
 * balance silently attributed to the wrong epoch corrupts every delta that
 * crosses it, and nothing downstream could detect that.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EconomicsInputs } from './sample.js';

/**
 * How stale the summary may be and still describe "the balance around this
 * epoch's distribution". The publisher runs every 10 minutes, so anything
 * beyond half an hour means it is not running and we should not be sampling.
 */
const MAX_SUMMARY_AGE_MS = 30 * 60 * 1000;

export interface SummaryBackedInputs extends EconomicsInputs {
  /** When the balance was observed on chain, unix ms. */
  observedAt: number;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read the current figures from the published portal summary.
 *
 * @param publicDir The publisher's output root.
 * @param now Injectable for tests.
 */
export function readEconomicsInputsFromSummary(
  publicDir: string,
  now: number = Date.now()
): SummaryBackedInputs | null {
  const path = join(publicDir, 'api/v1/portal/summary.json');
  if (!existsSync(path)) return null;

  try {
    const summary = JSON.parse(readFileSync(path, 'utf8')) as {
      generatedAt?: unknown;
      demandFactor?: unknown;
      counts?: { arnsRecords?: unknown };
      tokenSupply?: {
        protocolBalance?: unknown;
        circulating?: unknown;
        staked?: unknown;
        delegated?: unknown;
      };
    };

    const observedAt =
      typeof summary.generatedAt === 'string' ? Date.parse(summary.generatedAt) : Number.NaN;
    if (!Number.isFinite(observedAt)) return null;
    if (now - observedAt > MAX_SUMMARY_AGE_MS) return null;

    const protocolBalance = finiteOrNull(summary.tokenSupply?.protocolBalance);
    // The balance is the one field without which the row has no purpose.
    if (protocolBalance === null) return null;

    return {
      protocolBalance,
      circulating: finiteOrNull(summary.tokenSupply?.circulating),
      staked: finiteOrNull(summary.tokenSupply?.staked),
      delegated: finiteOrNull(summary.tokenSupply?.delegated),
      demandFactor: finiteOrNull(summary.demandFactor),
      arnsRecordCount: finiteOrNull(summary.counts?.arnsRecords),
      // Deliberately null rather than a fresh `getSlot()`: that would record
      // the slot at SAMPLING time, not the slot the balance was read at, which
      // is worse than admitting we do not know it.
      slot: null,
      observedAt,
    };
  } catch {
    return null;
  }
}
