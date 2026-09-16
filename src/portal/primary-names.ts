/**
 * Primary names, resolved from a scan this cycle already paid for.
 *
 * `ario.getPrimaryNames()` scans the core program once and then issues ONE
 * `getAccountInfo` per name to attach `processId` — a sequential N+1 over
 * every primary name on the cluster, every cycle. Measured against the live
 * endpoints on 2026-09-16 that single loop was ~81% of this service's entire
 * RPC bill: 233 reads per mainnet cycle and 220 per devnet cycle, 144 cycles a
 * day, ~65,000 calls daily to attach a field.
 *
 * The field is already here. `getArNSRecords()` sweeps the whole ArNS program
 * in the same cycle and every record carries `processId`, so the enrichment is
 * a map lookup rather than a round trip. We do the same scan the SDK does and
 * resolve `processId` locally: one `getProgramAccounts` either way, N fewer
 * `getAccountInfo`.
 *
 * The join reproduces the SDK's semantics exactly, including its forgiveness —
 * a primary name whose ArNS record has gone is skipped, not failed. What it
 * adds is a count of those skips, because silent forgiveness is how a broken
 * join looks identical to a genuinely smaller network.
 */

import { deserializePrimaryName } from '@ar.io/sdk';
// Imported rather than derived. The Anchor discriminator is just
// `sha256("account:PrimaryName")[0..8]` and computing it here would drop a
// dependency — but a struct rename would then silently scan for accounts that
// no longer exist and publish an empty document, where the import fails at
// build time. See tsconfig's `paths` note: the runtime resolves this subpath
// through the package's export map, the typechecker needs to be told.
import { PRIMARY_NAME_DISCRIMINATOR } from '@ar.io/solana-contracts/core';

/** The fields of an `ArnsRecord` this join needs. */
interface ArnsRecordLike {
  name?: unknown;
  processId?: unknown;
}

/**
 * The one field of a `PrimaryName` this join needs. The rest of the struct is
 * carried through untouched, so the shape stays open.
 */
interface PrimaryNameLike {
  name: string;
  [field: string]: unknown;
}

export interface PrimaryNameScan {
  /** Primary names joined to their ArNS record, in scan order. */
  items: unknown[];
  /** Accounts returned by the discriminator scan. */
  scanned: number;
  /** Scanned accounts whose ArNS record is absent — skipped, as the SDK does. */
  orphaned: number;
  /** Scanned accounts that would not deserialize — skipped, as the SDK does. */
  malformed: number;
}

/**
 * The SDK's join key: an undername (`sub_name`) resolves through its base
 * name, anything else through itself.
 *
 * Kept byte-identical to `getPrimaryNames`' own `baseNameOf` — it decides
 * which ArNS record a name resolves to, so a divergence here silently
 * repoints rows rather than failing. `split('_')` with a length check, not a
 * `startsWith`, because a name may legitimately contain further underscores
 * and only the two-part form is an undername.
 */
export function baseNameOf(name: string): string {
  const parts = name.toLowerCase().split('_');
  return parts.length === 2 ? parts[1] : parts[0];
}

/**
 * Index ArNS records by the exact name a primary name resolves against.
 *
 * Keyed on the record's own `name` rather than a normalised form: the SDK
 * reaches its record through a PDA derived from `baseNameOf(...)`, which is an
 * exact-match on the seed bytes. Keying on anything looser would join rows the
 * SDK would not have found.
 */
export function buildProcessIdIndex(arnsRecords: readonly unknown[]): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const record of arnsRecords) {
    const { name, processId } = (record ?? {}) as ArnsRecordLike;
    if (typeof name === 'string' && processId !== undefined) index.set(name, processId);
  }
  return index;
}

/**
 * Attach `processId` to each primary name from `index`.
 *
 * Pure, so the join is tested without an endpoint. Names with no matching
 * record are counted and dropped — the same outcome as the SDK's swallowed
 * `getArNSRecord` rejection, minus the round trip that produced it.
 */
export function joinPrimaryNames(
  primaryNames: readonly PrimaryNameLike[],
  index: ReadonlyMap<string, unknown>,
): { items: unknown[]; orphaned: number } {
  const items: unknown[] = [];
  let orphaned = 0;
  for (const primaryName of primaryNames) {
    const processId = index.get(baseNameOf(primaryName.name));
    if (processId === undefined) {
      orphaned++;
      continue;
    }
    items.push({ ...primaryName, processId });
  }
  return { items, orphaned };
}

/**
 * Why this scan must not be published, or null when it is fine.
 *
 * A join that resolves nothing is a broken join — a changed key, a reordered
 * fetch, an ArNS sweep that came back empty — not a cluster that dropped every
 * primary name at once. Publishing it would replace a good document with an
 * empty one, so the cycle refuses and the last good copy stays on disk. This
 * mirrors the gateway zero-guard in ../portal/daemon.ts.
 *
 * Orphans on their own are never a refusal: names outliving their ArNS record
 * is a real, ordinary state, and the SDK has always skipped them.
 */
export function primaryNameJoinFailure(scan: PrimaryNameScan): string | null {
  if (scan.scanned === 0) return null;
  if (scan.items.length > 0) return null;
  return (
    `all ${scan.scanned} primary name accounts failed to join ` +
    `(orphaned=${scan.orphaned} malformed=${scan.malformed})`
  );
}

/** The one method this module needs from the SDK client. */
export interface DiscriminatorScanner {
  coreProgram: unknown;
  getAccountsByDiscriminator(
    // `ArrayLike<number>`, because the contracts package exports the
    // discriminator as a ReadonlyUint8Array and the SDK only ever does
    // `Buffer.from(...)` with it.
    programId: unknown,
    discriminator: ArrayLike<number>,
  ): Promise<readonly { data: Buffer }[]>;
}

/**
 * Scan the core program for primary names and join them against `arnsRecords`.
 *
 * Costs exactly one `getProgramAccounts` — the same scan `getPrimaryNames()`
 * opens with, and then the whole of what it does afterwards.
 */
export async function fetchPrimaryNames(
  ario: DiscriminatorScanner,
  arnsRecords: readonly unknown[],
): Promise<PrimaryNameScan> {
  const accounts = await ario.getAccountsByDiscriminator(
    ario.coreProgram,
    PRIMARY_NAME_DISCRIMINATOR,
  );

  const primaryNames: PrimaryNameLike[] = [];
  let malformed = 0;
  for (const { data } of accounts) {
    try {
      primaryNames.push(deserializePrimaryName(data) as PrimaryNameLike);
    } catch {
      // Same forgiveness the SDK applies: an account that carries the
      // discriminator but will not decode is not this cycle's problem.
      malformed++;
    }
  }

  const { items, orphaned } = joinPrimaryNames(primaryNames, buildProcessIdIndex(arnsRecords));
  return { items, scanned: accounts.length, orphaned, malformed };
}
