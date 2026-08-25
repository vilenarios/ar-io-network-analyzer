/**
 * Where a stake sample gets its positions: the portal snapshot, off disk.
 *
 * ZERO ADDITIONAL RPC, and that is a design constraint rather than a happy
 * accident. The portal publisher already performs a whole-program scan of every
 * gateway and every delegate every 10 minutes and writes the result to
 * `portal/gateways.json` and `portal/delegates.json`. Reading those files costs
 * nothing on chain. Querying the ~805 positions individually each epoch would
 * add real load to fetch numbers we already have on disk.
 *
 * Same reasoning as `economics/inputs.ts`, and the same staleness rule: if the
 * snapshot is missing, unparseable or old, this returns null and the caller
 * skips the epoch rather than recording positions that may no longer be true.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** The publisher runs every 10 minutes; beyond half an hour it is not running. */
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

export type StakeKind = 'operator' | 'delegate';

export interface StakePosition {
  kind: StakeKind;
  /** The wallet that owns the position. */
  address: string;
  /** The gateway it is staked on. Equals `address` for an operator. */
  gatewayAddress: string;
  staked: number;
  vaulted: number;
  startTimestamp: number | null;
}

export interface StakeSnapshot {
  positions: StakePosition[];
  /** When the portal observed these on chain, unix ms. */
  observedAt: number;
}

function readDocument(publicDir: string, name: string): { generatedAt?: unknown; items?: unknown[] } | null {
  const path = join(publicDir, `api/v1/portal/${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { generatedAt?: unknown; items?: unknown[] };
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readStakePositions(publicDir: string, now: number = Date.now()): StakeSnapshot | null {
  const gateways = readDocument(publicDir, 'gateways');
  const delegates = readDocument(publicDir, 'delegates');
  if (!gateways || !delegates) return null;

  const at = (doc: { generatedAt?: unknown }) =>
    typeof doc.generatedAt === 'string' ? Date.parse(doc.generatedAt) : Number.NaN;
  const gatewaysAt = at(gateways);
  const delegatesAt = at(delegates);
  if (!Number.isFinite(gatewaysAt) || !Number.isFinite(delegatesAt)) return null;

  // The older of the two: a position set is only as current as its stalest half.
  const observedAt = Math.min(gatewaysAt, delegatesAt);
  if (now - observedAt > MAX_SNAPSHOT_AGE_MS) return null;

  const positions: StakePosition[] = [];

  for (const raw of gateways.items ?? []) {
    const gateway = raw as {
      gatewayAddress?: unknown;
      operator?: unknown;
      operatorStake?: unknown;
      status?: unknown;
    };
    const gatewayAddress = typeof gateway.gatewayAddress === 'string' ? gateway.gatewayAddress : null;
    const operator = typeof gateway.operator === 'string' ? gateway.operator : null;
    const staked = finite(gateway.operatorStake);
    if (!gatewayAddress || !operator || staked === null) continue;

    // Left-the-network gateways are still recorded: a position that exited is
    // exactly the one whose final earnings a portal needs to show.
    positions.push({
      kind: 'operator',
      address: operator,
      gatewayAddress,
      staked,
      // Operator withdrawals live in vaults.json, not here; recorded as 0 rather
      // than guessed, and never used as if it meant "no withdrawal in flight".
      vaulted: 0,
      startTimestamp: finite((raw as { startTimestamp?: unknown }).startTimestamp),
    });
  }

  for (const raw of delegates.items ?? []) {
    const delegate = raw as {
      address?: unknown;
      gatewayAddress?: unknown;
      delegatedStake?: unknown;
      vaultedStake?: unknown;
      startTimestamp?: unknown;
    };
    const address = typeof delegate.address === 'string' ? delegate.address : null;
    const gatewayAddress = typeof delegate.gatewayAddress === 'string' ? delegate.gatewayAddress : null;
    const staked = finite(delegate.delegatedStake);
    if (!address || !gatewayAddress || staked === null) continue;

    positions.push({
      kind: 'delegate',
      address,
      gatewayAddress,
      staked,
      vaulted: finite(delegate.vaultedStake) ?? 0,
      startTimestamp: finite(delegate.startTimestamp),
    });
  }

  if (positions.length === 0) return null;
  return { positions, observedAt };
}
