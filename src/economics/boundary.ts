/**
 * Recover the protocol balance as it stood at an epoch boundary.
 *
 * Rule 3 of the economics series says a row must be taken at a defined point in
 * the epoch lifecycle, because a delta between two rows is only meaningful if
 * both were measured at the same point. The original sampler approximated that
 * with "read the current balance whenever the job runs", which drifts: epoch
 * 523's first row was written 15.4 hours after its boundary, so its inflow
 * included 15.4 hours of the NEXT epoch's activity — 35,725 ARIO of it.
 *
 * This resolves the balance at the boundary instead, which is exact,
 * reproducible, and identical whether it runs an hour or a year later. That
 * last property is what lets live and recovered rows sit in one series.
 *
 * The method, validated against the live pipeline's independent SDK reading at
 * the same instant (exact match, to the mARIO):
 *
 *   1. Failed transactions appear in the signature history and changed nothing.
 *   2. A successful transaction that merely MENTIONS the account carries no
 *      balance entry for it.
 *   3. So walk back to the most recent transaction that DID carry one. That is
 *      not a fallback: if nothing later changed the balance, that value IS the
 *      balance at the boundary.
 */

/** A signature as `getSignaturesForAddress` returns it, narrowed to what we use. */
export interface SignatureRef {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
}

export interface BoundaryBalance {
  /** Null when the walk found no transaction carrying a balance for this account. */
  balance: number | null;
  /** The slot the balance was read at — the recovering transaction pins it. */
  slot: number | null;
  /** Transactions inspected, for cost reporting. */
  transactionsRead: number;
}

/** How far back to walk before giving up on a boundary. */
const MAX_WALK_BACK = 40;

/** Drop failures and undated entries, oldest first. Do this once, not per epoch. */
export function usableSignatures(signatures: SignatureRef[]): SignatureRef[] {
  return signatures
    .filter((entry) => entry.err === null && entry.blockTime !== null)
    .sort((a, b) => Number(a.blockTime) - Number(b.blockTime));
}

/**
 * @param signatures Pre-filtered by `usableSignatures`.
 * @param balanceAfter Post-transaction balance, or null when that transaction
 *   carried no entry for the account — which is expected, not an error.
 */
export async function recoverBoundaryBalance(
  signatures: SignatureRef[],
  endSeconds: number,
  balanceAfter: (signature: string) => Promise<number | null>
): Promise<BoundaryBalance> {
  const candidates = signatures
    .filter((entry) => Number(entry.blockTime) <= endSeconds)
    .reverse()
    .slice(0, MAX_WALK_BACK);

  let transactionsRead = 0;
  for (const candidate of candidates) {
    transactionsRead++;
    const balance = await balanceAfter(candidate.signature);
    if (balance !== null) {
      return { balance, slot: Number(candidate.slot), transactionsRead };
    }
  }
  // A failed walk still cost RPC calls; report them so callers can price it.
  return { balance: null, slot: null, transactionsRead };
}
