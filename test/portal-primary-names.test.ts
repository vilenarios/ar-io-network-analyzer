/**
 * The primary-name join that replaced one `getAccountInfo` per name.
 *
 * No network: the join is pure, so it is exercised against fixtures exactly as
 * the publisher tests exercise the document shape. The one test that does need
 * an endpoint is opt-in and asserts the thing that actually matters — that the
 * local join and the SDK's own N+1 produce identical output.
 */

import test from 'node:test';
import { PRIMARY_NAME_DISCRIMINATOR } from '@ar.io/solana-contracts/core';
import assert from 'node:assert/strict';
import { splitPrimaryName } from '@ar.io/sdk';
import {
  baseNameOf,
  buildProcessIdIndex,
  fetchPrimaryNames,
  joinPrimaryNames,
  primaryNameJoinFailure,
} from '../src/portal/primary-names.js';

const records = [
  { name: 'alice', processId: 'ant-alice' },
  { name: 'bob', processId: 'ant-bob' },
];

test('baseNameOf resolves an undername through its base name', () => {
  assert.equal(baseNameOf('alice'), 'alice');
  assert.equal(baseNameOf('sub_alice'), 'alice');
});

test('baseNameOf lowercases, matching the PDA seed the SDK derives', () => {
  assert.equal(baseNameOf('ALICE'), 'alice');
  assert.equal(baseNameOf('Sub_Alice'), 'alice');
});

test('baseNameOf splits on the FIRST underscore, as the contract does', () => {
  // Was asserting 'a' while the SDK was pinned to a version with the buggy
  // inline rule. The 4.5.0 bump brings the corrected `splitPrimaryName`, so
  // `a_b_c` is undername `a` of base `b_c` and resolves through `b_c`.
  assert.equal(baseNameOf('a_b_c'), 'b_c');
  assert.equal(baseNameOf('x_y_z_w'), 'y_z_w');
});

test('baseNameOf agrees with the SDK helper it delegates to', () => {
  // The guard that replaces the data-dependent parity tripwire: this one is
  // structural and fails the moment a private copy drifts from the shared rule.
  for (const n of ['alice', 'sub_alice', 'a_b_c', 'x_y_z_w', 'ALICE', 'Sub_Alice']) {
    assert.equal(baseNameOf(n), splitPrimaryName(n).baseName, n);
  }
});

test('buildProcessIdIndex skips records missing a name or a processId', () => {
  const index = buildProcessIdIndex([
    ...records,
    { name: 'no-process' },
    { processId: 'no-name' },
    null,
    'not-a-record',
  ]);
  assert.deepEqual([...index.keys()].sort(), ['alice', 'bob']);
});

test('joins processId onto each primary name', () => {
  const { items, orphaned } = joinPrimaryNames(
    [{ name: 'alice' }, { name: 'bob' }],
    buildProcessIdIndex(records),
  );
  assert.equal(orphaned, 0);
  assert.deepEqual(items, [
    { name: 'alice', processId: 'ant-alice' },
    { name: 'bob', processId: 'ant-bob' },
  ]);
});

test('resolves an undername through its base record', () => {
  const { items, orphaned } = joinPrimaryNames(
    [{ name: 'sub_alice' }],
    buildProcessIdIndex(records),
  );
  assert.equal(orphaned, 0);
  assert.deepEqual(items, [{ name: 'sub_alice', processId: 'ant-alice' }]);
});

test('drops a name whose ArNS record is gone, and counts it', () => {
  // The SDK swallows the `getArNSRecord` rejection and skips the row. Same
  // outcome here — but counted, so a broken join cannot look like a smaller
  // network.
  const { items, orphaned } = joinPrimaryNames(
    [{ name: 'alice' }, { name: 'ghost' }],
    buildProcessIdIndex(records),
  );
  assert.equal(orphaned, 1);
  assert.deepEqual(items, [{ name: 'alice', processId: 'ant-alice' }]);
});

test('preserves every other field on the primary name', () => {
  const { items } = joinPrimaryNames(
    [{ name: 'alice', owner: 'wallet-1', startTimestamp: 42 }],
    buildProcessIdIndex(records),
  );
  assert.deepEqual(items, [
    { name: 'alice', owner: 'wallet-1', startTimestamp: 42, processId: 'ant-alice' },
  ]);
});

test('an empty ArNS sweep orphans everything rather than throwing', () => {
  // This is the shape the publisher refuses to publish: scanned > 0, items 0.
  const { items, orphaned } = joinPrimaryNames([{ name: 'alice' }], buildProcessIdIndex([]));
  assert.equal(items.length, 0);
  assert.equal(orphaned, 1);
});

/** Records a single getProgramAccounts scan and replays `accounts` from it. */
function scanningRpc(
  accounts: Buffer[],
  calls: { programId: string; filters: unknown[] }[],
) {
  return {
    getProgramAccounts(
      programId: string,
      config: { filters: unknown[] },
    ) {
      calls.push({ programId, filters: config.filters });
      return {
        send: async () =>
          accounts.map((data) => ({
            account: { data: [data.toString('base64'), 'base64'] as const },
          })),
      };
    },
  };
}

test('fetchPrimaryNames issues exactly one scan and forgives what will not decode', async () => {
  // The whole point of the change: one `getProgramAccounts`, no per-name read.
  const calls: { programId: string; filters: unknown[] }[] = [];
  // Two accounts carrying the discriminator, neither a decodable PrimaryName —
  // the SDK skips these and so do we.
  const scan = await fetchPrimaryNames(
    scanningRpc([Buffer.alloc(4), Buffer.alloc(8)], calls),
    'core-program',
    records,
  );

  assert.equal(calls.length, 1, 'exactly one program scan per cycle');
  assert.equal(calls[0].programId, 'core-program');
  assert.equal(scan.scanned, 2);
  // Every scanned account is accounted for: joined, orphaned, or malformed.
  assert.equal(scan.items.length + scan.orphaned + scan.malformed, scan.scanned);
});

test('fetchPrimaryNames filters the scan on the primary-name discriminator', async () => {
  // Without the memcmp the scan would stream back every core-program account,
  // which is both wrong and enormous.
  const calls: { programId: string; filters: unknown[] }[] = [];
  await fetchPrimaryNames(scanningRpc([], calls), 'core-program', records);

  assert.equal(calls[0].filters.length, 1);
  const { memcmp } = calls[0].filters[0] as {
    memcmp: { offset: bigint; bytes: string; encoding: string };
  };
  assert.equal(memcmp.offset, 0n, 'discriminator sits at offset 0');
  assert.equal(memcmp.encoding, 'base64');
  assert.equal(
    memcmp.bytes,
    Buffer.from(PRIMARY_NAME_DISCRIMINATOR).toString('base64'),
    'must be the PrimaryName discriminator, not another account type',
  );
});

/**
 * The regression this change could actually cause: output that differs from
 * `getPrimaryNames()`. Opt-in because running it costs the N+1 we removed —
 * run it when the SDK is upgraded, not on every commit.
 *
 *   PORTAL_SDK_PARITY=1 SOLANA_RPC_URL=... yarn test
 */
test(
  'local join matches the SDK getPrimaryNames output',
  { skip: process.env.PORTAL_SDK_PARITY ? false : 'set PORTAL_SDK_PARITY=1 to run' },
  async () => {
    const { initSolanaArio } = await import('../src/data/gateway-fetcher.js');
    const { ario, rpc, programIds } = await initSolanaArio();
    const FULL_SCAN = { limit: Number.MAX_SAFE_INTEGER } as const;

    const paged = (r: unknown) => ((r as { items?: unknown[] }).items ?? []);
    const arnsRecords = paged(await ario.getArNSRecords(FULL_SCAN));

    const mine = await fetchPrimaryNames(rpc as never, programIds.core, arnsRecords);
    const theirs = paged(await ario.getPrimaryNames(FULL_SCAN));

    // Compare as sets of field-sorted rows: the SDK returns scan order, which
    // is not a contract either side promises to preserve.
    const canonical = (rows: unknown[]) =>
      rows.map((r) => JSON.stringify(r, Object.keys(r as object).sort())).sort();

    assert.deepEqual(canonical(mine.items), canonical(theirs));
  },
);

// --- the refusal ------------------------------------------------------------

test('a healthy scan is publishable', () => {
  assert.equal(
    primaryNameJoinFailure({ items: [{}], scanned: 1, orphaned: 0, malformed: 0 }),
    null,
  );
});

test('a cluster with genuinely no primary names is publishable', () => {
  // Nothing scanned means nothing to join; that is not a broken join.
  assert.equal(
    primaryNameJoinFailure({ items: [], scanned: 0, orphaned: 0, malformed: 0 }),
    null,
  );
});

test('orphans alone never refuse a cycle', () => {
  // Names outliving their ArNS record is an ordinary state the SDK also skips.
  assert.equal(
    primaryNameJoinFailure({ items: [{}], scanned: 9, orphaned: 8, malformed: 0 }),
    null,
  );
});

test('a scan that joined nothing at all is refused', () => {
  const why = primaryNameJoinFailure({ items: [], scanned: 233, orphaned: 233, malformed: 0 });
  assert.match(String(why), /all 233 primary name accounts failed to join/);
  assert.match(String(why), /orphaned=233/);
});
