/**
 * How a capture cycle is judged.
 *
 * Split out of the daemon because it is the difference between a green light
 * and a silent blackout, and because a pure function can be tested without a
 * daemon, a database or an RPC endpoint.
 *
 * The rule that matters: a cycle that completed its RPC call is NOT
 * automatically `ok`. The primary query filters on `dataSize = 469`, so a
 * one-byte growth in the Observation account makes it match zero accounts
 * forever — an outcome indistinguishable, at the transport layer, from
 * perfect success. Observation accounts are swept off the chain by
 * permissionless `close_observation` within days, so every cycle spent
 * "succeeding" that way is data lost permanently. Anything that cannot be
 * explained as normal is recorded as `anomaly`, which every health surface
 * treats as unhealthy.
 */

export type CycleStatus = 'ok' | 'stale' | 'anomaly' | 'failed';

/** Machine-readable reason codes written to `poll_runs.error`. */
export type AnomalyCode =
  | 'LAYOUT_DRIFT'
  | 'ZERO_ACCOUNTS'
  | 'ALL_ACCOUNTS_UNPARSED'
  | 'DUPLICATE_OBSERVER_KEYS';

export interface CycleSignals {
  /** Accounts returned by the size+discriminator filtered query. */
  accountCount: number;
  /** Accounts that decoded cleanly. */
  decodedCount: number;
  /** The RPC context slot went backwards — this read came from a lagging replica. */
  isStale: boolean;
  /** Discriminator-only canary counted more accounts than the sized query. */
  layoutDrift: boolean;
  /** Two accounts in one read claimed the same (epoch, observer). */
  duplicateKeys: number;
}

export interface CycleClassification {
  status: CycleStatus;
  anomaly: AnomalyCode | null;
}

/**
 * Classify one completed cycle.
 *
 * Ordered by how badly each condition invalidates the capture: a layout drift
 * means the query itself is wrong, zero accounts means we captured nothing,
 * and only then do the softer conditions apply.
 */
export function classifyCycle(signals: CycleSignals): CycleClassification {
  if (signals.layoutDrift) return { status: 'anomaly', anomaly: 'LAYOUT_DRIFT' };
  if (signals.accountCount === 0) return { status: 'anomaly', anomaly: 'ZERO_ACCOUNTS' };
  if (signals.decodedCount === 0) return { status: 'anomaly', anomaly: 'ALL_ACCOUNTS_UNPARSED' };
  if (signals.duplicateKeys > 0) {
    return { status: 'anomaly', anomaly: 'DUPLICATE_OBSERVER_KEYS' };
  }
  if (signals.isStale) return { status: 'stale', anomaly: null };
  return { status: 'ok', anomaly: null };
}

/**
 * Is this status a healthy capture?
 *
 * `stale` is transient — the next read from a caught-up replica clears it, and
 * it costs nothing because the monotonic upsert refuses to regress the store.
 * Everything else is unhealthy and must reach an operator.
 */
export function isHealthyStatus(status: string): boolean {
  return status === 'ok' || status === 'stale';
}

/** Statuses that count toward the consecutive-unhealthy alarm. */
export function isUnhealthyStatus(status: string): boolean {
  return status === 'failed' || status === 'anomaly';
}
