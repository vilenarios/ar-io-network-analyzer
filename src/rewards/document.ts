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
 * BOUNDED SIZE. The per-epoch arrays would otherwise grow without limit: at
 * ~36 bytes per position-epoch, a year of daily epochs across ~1,000 positions
 * projects to roughly 12.5 MB, which every consumer would download to read one
 * row. So the arrays cover a rolling window of the most recent
 * `REWARDS_WINDOW_EPOCHS`, while `lifetimeRewards` is computed over the FULL
 * history and is never truncated. "What have I earned in total" therefore stays
 * correct forever; only the per-epoch chart is bounded.
 *
 * NO APY FIELD, deliberately, in the same spirit as publishing no `revenue`.
 * An annual rate from days of history is an extrapolation, and which one is a
 * presentation decision: simple or compounded, time-weighted or not, per
 * position or per wallet. The components are here — per-epoch rewards, the
 * stake they were earned on, and the epoch's end time — so a consumer can do
 * it explicitly and label it honestly.
 */

export const REWARDS_SCHEMA_VERSION = '1.1';

/**
 * How many recent epochs carry a per-epoch breakdown.
 *
 * Thirty daily epochs is a month of chart, ~850 KB at present position counts
 * and well under 200 KB gzipped. Lifetime totals are unaffected by this.
 */
export const REWARDS_WINDOW_EPOCHS = 30;

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
  /** Sum of the non-null entries above — the published WINDOW only, mARIO. */
  windowRewards: number;
  /**
   * Total earned across the position's whole recorded history, mARIO.
   *
   * Computed over every scanned epoch, not just the published window, so it
   * stays correct as the window rolls forward. This is the number to show for
   * "what have I earned".
   */
  lifetimeRewards: number;
  /** Epochs in which this position was credited, over the whole history. */
  epochsRewarded: number;
  /** Most recent observed stake, mARIO, or null if never sampled. */
  currentStake: number | null;
  /** How the figures were obtained. `inferred` rows are not yet published. */
  basis: 'events' | 'inferred';
}

export interface RewardsDocument {
  schemaVersion: string;
  generatedAt: string;
  /**
   * Epoch indexes the `rewards` arrays are aligned to, oldest first — a rolling
   * window, NOT the full history. `lifetimeRewards` covers everything.
   */
  epochs: number[];
  /** Epochs actually recorded, of which `epochs` publishes the most recent. */
  totalEpochsRecorded: number;
  /** Epoch end times, unix ms, aligned to `epochs`. */
  epochEndTimestamps: (number | null)[];
  counts: { delegate: number; operator: number };
  /** Lifetime sums across all positions, mARIO. */
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
export interface OperatorRewardRow {
  epochIndex: number;
  address: string;
  gatewayAddress: string;
  reward: number | null;
}

export function buildRewardsDocument(
  scannedEpochs: number[],
  epochEndSeconds: (epochIndex: number) => number | null,
  rewardRows: RewardRow[],
  stakeRows: StakeRow[],
  generatedAt: string,
  operatorRows: OperatorRewardRow[] = [],
  windowEpochs: number = REWARDS_WINDOW_EPOCHS
): RewardsDocument {
  const allEpochs = [...scannedEpochs].sort((a, b) => a - b);
  // The published window is the tail; lifetime figures below use every epoch.
  const epochs = allEpochs.slice(-windowEpochs);
  const slotOf = new Map(epochs.map((epochIndex, index) => [epochIndex, index]));

  const stakeByPosition = new Map(
    stakeRows.map((row) => [`${row.kind}|${row.address}|${row.gatewayAddress}`, row.staked])
  );

  const positions = new Map<string, RewardPosition>();

  function upsert(
    key: string,
    kind: 'delegate' | 'operator',
    address: string,
    gatewayAddress: string,
    basis: 'events' | 'inferred'
  ): RewardPosition {
    let position = positions.get(key);
    if (!position) {
      position = {
        kind,
        address,
        gatewayAddress,
        rewards: epochs.map(() => null),
        windowRewards: 0,
        lifetimeRewards: 0,
        epochsRewarded: 0,
        currentStake: stakeByPosition.get(key) ?? null,
        basis,
      };
      positions.set(key, position);
    }
    return position;
  }

  /** Record one epoch's amount: lifetime always, the array only in-window. */
  function credit(position: RewardPosition, epochIndex: number, amount: number): void {
    position.lifetimeRewards += amount;
    position.epochsRewarded++;
    const slot = slotOf.get(epochIndex);
    if (slot === undefined) return;
    position.rewards[slot] = (position.rewards[slot] ?? 0) + amount;
    position.windowRewards += amount;
  }

  for (const row of rewardRows) {
    const position = upsert(
      `delegate|${row.delegate}|${row.gateway}`,
      'delegate',
      row.delegate,
      row.gateway,
      'events'
    );
    credit(position, row.epochIndex, row.amount);
  }

  // Operator rows are derived, not measured, and carry `basis: 'inferred'` so
  // the difference survives into the document rather than being flattened.
  for (const row of operatorRows) {
    const position = upsert(
      `operator|${row.address}|${row.gatewayAddress}`,
      'operator',
      row.address,
      row.gatewayAddress,
      'inferred'
    );
    // A null stays null: an epoch whose stake was disturbed has no honest
    // figure, and treating it as zero would understate earnings silently.
    if (row.reward === null) continue;
    credit(position, row.epochIndex, row.reward);
  }

  const ordered = [...positions.values()].sort((a, b) => b.lifetimeRewards - a.lifetimeRewards);

  return {
    schemaVersion: REWARDS_SCHEMA_VERSION,
    generatedAt,
    epochs,
    totalEpochsRecorded: allEpochs.length,
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
        .reduce((sum, p) => sum + p.lifetimeRewards, 0),
      operatorRewards: ordered
        .filter((p) => p.kind === 'operator')
        .reduce((sum, p) => sum + p.lifetimeRewards, 0),
    },
    positions: ordered,
  };
}
