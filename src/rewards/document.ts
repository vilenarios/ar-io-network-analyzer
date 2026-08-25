/**
 * `/api/v1/rewards.json` — what each position has actually earned.
 *
 * TWO KINDS OF ROW, WITH DIFFERENT GUARANTEES, and the document says which is
 * which rather than blending them:
 *
 *   delegate  — `rewards` are EXACT, decoded from the program's own
 *               `CompoundDelegationRewards` events. Backfilled from chain
 *               history, so the series starts at the first epoch captured.
 *   operator  — no per-operator event exists; `DistributeEpoch` emits only an
 *               epoch summary. Operator earnings must be inferred from stake
 *               observed either side of an epoch, so they begin only once two
 *               snapshots exist and are absent before that.
 *
 * Publishing both under one `rewards` field with no distinction would make an
 * inferred figure indistinguishable from a measured one.
 *
 * NO APY FIELD, deliberately, in the same spirit as publishing no `revenue`.
 * An annual rate from days of history is an extrapolation, and which one is a
 * presentation decision: simple or compounded, time-weighted or not, per
 * position or per wallet. The components are here — per-epoch rewards, the
 * stake they were earned on, and the epoch's end time — so a consumer can do
 * it explicitly and label it honestly.
 */

export const REWARDS_SCHEMA_VERSION = '1.0';

export interface RewardPosition {
  kind: 'delegate' | 'operator';
  address: string;
  gatewayAddress: string;
  /**
   * Rewards per epoch, aligned index-for-index with the document's `epochs`.
   * `null` means the epoch was scanned and this position earned nothing —
   * distinct from an epoch missing from `epochs`, which was never scanned.
   */
  rewards: (number | null)[];
  /** Sum of the non-null entries above, mARIO. */
  totalRewards: number;
  /** Epochs in which this position was credited. */
  epochsRewarded: number;
  /** Most recent observed stake, mARIO, or null if never sampled. */
  currentStake: number | null;
  /** How the figures were obtained. `inferred` rows are not yet published. */
  basis: 'events' | 'inferred';
}

export interface RewardsDocument {
  schemaVersion: string;
  generatedAt: string;
  /** Epoch indexes the `rewards` arrays are aligned to, oldest first. */
  epochs: number[];
  /** Epoch end times, unix ms, aligned to `epochs`. */
  epochEndTimestamps: (number | null)[];
  counts: { delegate: number; operator: number };
  totals: { delegateRewards: number; operatorRewards: number };
  positions: RewardPosition[];
}

export interface RewardRow {
  epochIndex: number;
  delegate: string;
  gateway: string;
  amount: number;
}

export interface StakeRow {
  kind: 'delegate' | 'operator';
  address: string;
  gatewayAddress: string;
  staked: number;
}

/**
 * @param scannedEpochs Epochs actually scanned for events, oldest first. Only
 *   these appear in `epochs`, so a consumer can never read an unscanned epoch
 *   as one in which nothing was earned.
 */
export function buildRewardsDocument(
  scannedEpochs: number[],
  epochEndSeconds: (epochIndex: number) => number | null,
  rewardRows: RewardRow[],
  stakeRows: StakeRow[],
  generatedAt: string
): RewardsDocument {
  const epochs = [...scannedEpochs].sort((a, b) => a - b);
  const slotOf = new Map(epochs.map((epochIndex, index) => [epochIndex, index]));

  const stakeByPosition = new Map(
    stakeRows.map((row) => [`${row.kind}|${row.address}|${row.gatewayAddress}`, row.staked])
  );

  const positions = new Map<string, RewardPosition>();

  for (const row of rewardRows) {
    const slot = slotOf.get(row.epochIndex);
    if (slot === undefined) continue;

    const key = `delegate|${row.delegate}|${row.gateway}`;
    let position = positions.get(key);
    if (!position) {
      position = {
        kind: 'delegate',
        address: row.delegate,
        gatewayAddress: row.gateway,
        rewards: epochs.map(() => null),
        totalRewards: 0,
        epochsRewarded: 0,
        currentStake: stakeByPosition.get(key) ?? null,
        basis: 'events',
      };
      positions.set(key, position);
    }

    // Summed rather than assigned: the store already aggregates per epoch, but
    // a duplicated row must not silently overwrite a real one.
    position.rewards[slot] = (position.rewards[slot] ?? 0) + row.amount;
    position.totalRewards += row.amount;
  }

  for (const position of positions.values()) {
    position.epochsRewarded = position.rewards.filter((value) => value !== null).length;
  }

  const ordered = [...positions.values()].sort((a, b) => b.totalRewards - a.totalRewards);

  return {
    schemaVersion: REWARDS_SCHEMA_VERSION,
    generatedAt,
    epochs,
    epochEndTimestamps: epochs.map((epochIndex) => {
      const seconds = epochEndSeconds(epochIndex);
      // Seconds in the store, milliseconds on the wire — publishing raw puts
      // every timestamp in 1970 for anyone calling `new Date(value)`.
      return seconds === null ? null : seconds * 1000;
    }),
    counts: {
      delegate: ordered.filter((p) => p.kind === 'delegate').length,
      operator: ordered.filter((p) => p.kind === 'operator').length,
    },
    totals: {
      delegateRewards: ordered
        .filter((p) => p.kind === 'delegate')
        .reduce((sum, p) => sum + p.totalRewards, 0),
      // Operator earnings need two stake observations; until then this is
      // honestly zero rather than a number nothing supports.
      operatorRewards: 0,
    },
    positions: ordered,
  };
}
