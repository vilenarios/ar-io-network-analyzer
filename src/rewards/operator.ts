/**
 * Derive gateway-operator earnings from stake observed either side of an epoch.
 *
 * Operators have no per-operator reward event — `DistributeEpoch` emits only an
 * epoch summary — so unlike delegates their earnings cannot be measured
 * directly. What can be done is honest subtraction:
 *
 *   reward(epoch) = staked(epoch) - staked(epoch - 1)
 *
 * valid ONLY when nothing else moved the stake in between. `stake_change_flags`
 * records the epochs where something did (the operator staked, withdrew, or
 * claimed a withdrawal), and those epochs yield null rather than a contaminated
 * figure. In practice that is around 1.2% of positions per epoch.
 *
 * Three further cases deliberately yield null rather than a number:
 *
 *   - no observation for the previous epoch. There is nothing to subtract, and
 *     the first sampled epoch has no predecessor by definition.
 *   - a negative delta with no flag. Stake should not fall while only earning,
 *     so this means a movement was missed — reporting a negative reward, or
 *     clamping it to zero, would both hide that.
 *   - a position absent from one of the two snapshots, i.e. it joined or left.
 *
 * These figures are labelled `inferred` wherever they are published and must
 * never be presented as equivalent to a delegate's measured reward.
 */

import type { Database } from 'better-sqlite3';

export interface OperatorEpochReward {
  epochIndex: number;
  address: string;
  gatewayAddress: string;
  /** mARIO earned, or null when it cannot be derived honestly. */
  reward: number | null;
  /** Why it is null, for operators and for the runbook. */
  reason?: 'no-previous-sample' | 'stake-changed' | 'negative-delta';
}

interface SampleRow {
  epoch_index: number;
  address: string;
  gateway_address: string;
  staked: number;
}

/**
 * Derive rewards for every operator position across all sampled epochs.
 *
 * Reads only retained samples and flags — no RPC, no chain access.
 */
export function deriveOperatorRewards(db: Database): OperatorEpochReward[] {
  const samples = db
    .prepare<[], SampleRow>(
      `SELECT epoch_index, address, gateway_address, staked
         FROM stake_samples WHERE kind = 'operator'
        ORDER BY address, gateway_address, epoch_index ASC`
    )
    .all();

  const flagged = new Set(
    (
      db
        .prepare<[], { epoch_index: number; address: string; gateway_address: string }>(
          `SELECT epoch_index, address, gateway_address
             FROM stake_change_flags WHERE kind = 'operator'`
        )
        .all()
    ).map((row) => `${row.epoch_index}|${row.address}|${row.gateway_address}`)
  );

  const byPosition = new Map<string, SampleRow[]>();
  for (const row of samples) {
    const key = `${row.address}|${row.gateway_address}`;
    const list = byPosition.get(key);
    if (list) list.push(row);
    else byPosition.set(key, [row]);
  }

  const out: OperatorEpochReward[] = [];

  for (const rows of byPosition.values()) {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const current = rows[i];
      const base = {
        epochIndex: current.epoch_index,
        address: current.address,
        gatewayAddress: current.gateway_address,
      };

      // Epochs must be adjacent. A gap means the intervening movement is
      // unobserved, so the difference spans more than one epoch's earning.
      if (current.epoch_index !== previous.epoch_index + 1) {
        out.push({ ...base, reward: null, reason: 'no-previous-sample' });
        continue;
      }
      if (flagged.has(`${current.epoch_index}|${current.address}|${current.gateway_address}`)) {
        out.push({ ...base, reward: null, reason: 'stake-changed' });
        continue;
      }

      const delta = Number(current.staked) - Number(previous.staked);
      if (delta < 0) {
        out.push({ ...base, reward: null, reason: 'negative-delta' });
        continue;
      }
      out.push({ ...base, reward: delta });
    }
  }

  return out;
}
