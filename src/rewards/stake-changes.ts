/**
 * Detect epochs in which a position's stake moved for a reason other than
 * earning, so an inferred reward is never contaminated by a deposit.
 *
 * An operator's earnings can only be derived from the change in their stake
 * across an epoch, because `DistributeEpoch` emits no per-operator record. That
 * derivation is only valid if nothing ELSE moved the stake. These are the
 * instructions that do:
 *
 *   DecreaseOperatorStake  the operator withdraws (into a vault; PDA-only)
 *   JoinNetwork            the operator's initial stake
 *   ClaimWithdrawal        a matured withdrawal is claimed out
 *
 * ATTRIBUTION, AND THE MISTAKE IT AVOIDS. Matching a gateway simply because it
 * appears in a transaction's accounts is wrong: the account that cranks epoch
 * distribution is itself a gateway operator, so it appeared in every payout it
 * submitted — 30 of 30 sampled — which would have credited the whole network's
 * rewards to two gateways.
 *
 * These instructions are different in a checkable way: the operator signs them
 * personally. So a gateway is flagged only when it appears in the accounts AND
 * its registered operator IS the transaction's signer. Combined with matching
 * on the instruction name, that excludes the cranking case entirely.
 *
 * Over-flagging is deliberately the safe direction: a flagged epoch yields a
 * null reward rather than a wrong one.
 */

/** Instructions that move operator stake without it being a reward. */
export const STAKE_CHANGE_INSTRUCTIONS = [
  'DecreaseOperatorStake',
  'JoinNetwork',
  'ClaimWithdrawal',
] as const;

export type StakeChangeInstruction = (typeof STAKE_CHANGE_INSTRUCTIONS)[number];

export interface StakeChangeFlag {
  kind: 'operator';
  address: string;
  gatewayAddress: string;
  instruction: StakeChangeInstruction;
}

export interface TransactionShape {
  /** Log messages, used to identify the instruction. */
  logMessages: readonly string[];
  /** Account keys in order; index 0 is the fee payer and signer. */
  accountKeys: readonly string[];
}

/**
 * @param operatorOf Resolves a gateway address to its registered operator.
 *   Returns null for an unknown gateway, which is then not flagged.
 */
export function detectStakeChanges(
  tx: TransactionShape,
  operatorOf: (gatewayAddress: string) => string | null
): StakeChangeFlag[] {
  const instruction = STAKE_CHANGE_INSTRUCTIONS.find((name) =>
    tx.logMessages.includes(`Program log: Instruction: ${name}`)
  );
  if (!instruction) return [];

  const signer = tx.accountKeys[0];
  if (!signer) return [];

  const flags: StakeChangeFlag[] = [];
  const seen = new Set<string>();

  for (const key of tx.accountKeys) {
    const operator = operatorOf(key);
    // The self-signature check: without it this degenerates into "any gateway
    // mentioned", which is precisely the invalid attribution described above.
    if (operator === null || operator !== signer) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({ kind: 'operator', address: operator, gatewayAddress: key, instruction });
  }

  return flags;
}
