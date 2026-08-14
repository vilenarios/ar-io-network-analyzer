/**
 * The Epoch account store.
 *
 * This table exists because `close_epoch` is permissionless: the failure tally
 * the protocol itself computed, and the record of which prescribed observers
 * actually submitted, stop being readable the moment anyone closes the epoch —
 * and no operator controls when that happens. Once the account is gone this
 * row is the only copy, so the properties that matter are the ones whose
 * violation would silently destroy it:
 *
 *  - MONOTONICITY: a lagging RPC replica must not overwrite a newer capture.
 *    Unlike observations there is no revisions table to fall back on here.
 *  - BLOB FIDELITY: failure_counts is a Uint16Array written through SQLite as
 *    raw bytes. If endianness or the byteOffset slice were wrong the counts
 *    would still read back as plausible numbers — just the wrong ones.
 *  - PROGRESSION: a live epoch's counters advance every cycle, so an update
 *    must actually land rather than being treated as a duplicate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertEpochs } from '../src/db/repo-write.js';
import { memoryDb } from './helpers.js';
import type { DecodedEpoch, SdkEpoch } from '../src/capture/decode.js';

function epochAccount(overrides: Partial<SdkEpoch> = {}, pubkey = 'EpochPda111'): DecodedEpoch {
  const failureCounts = new Uint16Array(3000);
  // 0x0102 catches a byte-order mistake: read back little-endian it is 258,
  // byte-swapped it is 513.
  failureCounts[0] = 0x0102;
  failureCounts[7] = 65535;
  failureCounts[2999] = 42;

  const epoch: SdkEpoch = {
    epochIndex: 511,
    startTimestamp: 1786493050,
    endTimestamp: 1786579450,
    totalEligibleRewards: 70254840794,
    perGatewayReward: 178424992,
    perObserverReward: 281019363,
    rewardRate: 599,
    activeGatewayCount: 643,
    distributionIndex: 0,
    tallyIndex: 0,
    observerCount: 50,
    nameCount: 2,
    observationsSubmitted: 3,
    rewardsDistributed: 0,
    weightsTallied: 0,
    prescriptionsDone: 1,
    failureCounts,
    hasObserved: Uint8Array.from([0b0000_0111, 0, 0, 0, 0, 0, 0]),
    prescribedObservers: ['ObsA', 'ObsB', 'ObsC'],
    prescribedObserverGateways: ['GwA', 'GwB', 'GwC'],
    prescribedNameHashes: [Buffer.from([0xde, 0xad]), Buffer.from([0xbe, 0xef])],
    ...overrides,
  };

  return { pubkey, accountBytes: 9408, epoch };
}

function readEpoch(db: ReturnType<typeof memoryDb>, epochIndex = 511) {
  return db.prepare('SELECT * FROM epochs WHERE epoch_index = ?').get(epochIndex) as
    | Record<string, never>
    | undefined;
}

test('a first sighting inserts, and the same bytes again update rather than duplicate', () => {
  const db = memoryDb();

  const first = upsertEpochs(db, [epochAccount()], 1000, 500);
  assert.deepEqual(first, { inserted: 1, updated: 0, stale: 0 });

  const second = upsertEpochs(db, [epochAccount()], 2000, 600);
  assert.deepEqual(second, { inserted: 0, updated: 1, stale: 0 });

  const { c } = db.prepare('SELECT COUNT(*) c FROM epochs').get() as { c: number };
  assert.equal(c, 1);
});

test('first_seen is preserved while last_seen advances', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);
  upsertEpochs(db, [epochAccount()], 2000, 600);

  const row = readEpoch(db)!;
  assert.equal(row.first_seen_at, 1000, 'first_seen_at must record the original sighting');
  assert.equal(row.first_seen_slot, 500);
  assert.equal(row.last_seen_at, 2000);
  assert.equal(row.last_seen_slot, 600);
});

test('a lagging replica cannot overwrite a newer capture', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount({ tallyIndex: 643, weightsTallied: 1 })], 2000, 600);

  // Same epoch, but read from a node 100 slots behind, and mid-tally.
  const stale = upsertEpochs(db, [epochAccount({ tallyIndex: 12, weightsTallied: 0 })], 3000, 500);
  assert.deepEqual(stale, { inserted: 0, updated: 0, stale: 1 });

  const row = readEpoch(db)!;
  assert.equal(row.tally_index, 643, 'the newer tally must survive the older read');
  assert.equal(row.weights_tallied, 1);
  assert.equal(row.last_seen_slot, 600, 'last_seen_slot must not regress');
});

test('an equal-slot re-read is accepted, not refused as stale', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);
  const same = upsertEpochs(db, [epochAccount({ observationsSubmitted: 9 })], 1500, 500);

  assert.deepEqual(same, { inserted: 0, updated: 1, stale: 0 });
  assert.equal(readEpoch(db)!.observations_submitted, 9);
});

test('failure_counts survives the round trip as a little-endian Uint16Array', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);

  const stored = readEpoch(db)!.failure_counts as unknown as Buffer;
  assert.equal(stored.length, 6000, '3000 gateway slots at 2 bytes each');

  const counts = new Uint16Array(stored.buffer, stored.byteOffset, stored.byteLength / 2);
  assert.equal(counts[0], 0x0102, 'byte order must be preserved');
  assert.equal(counts[7], 65535, 'a saturated count must not wrap or clamp');
  assert.equal(counts[2999], 42, 'the final slot must not be truncated');
  assert.equal(
    Array.from(counts).filter((c) => c > 0).length,
    3,
    'no spurious nonzero counts'
  );
});

test('has_observed popcount matches observations_submitted', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);

  const row = readEpoch(db)!;
  const bitmap = row.has_observed as unknown as Buffer;
  const observed = Array.from(bitmap).reduce(
    (total, byte) => total + byte.toString(2).replace(/0/g, '').length,
    0
  );
  assert.equal(bitmap.length, 7, '50 prescribed observers packed into 7 bytes');
  assert.equal(observed, row.observations_submitted);
});

test('prescription lists and name hashes are stored losslessly', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);

  const row = readEpoch(db)!;
  assert.deepEqual(JSON.parse(row.prescribed_observers), ['ObsA', 'ObsB', 'ObsC']);
  assert.deepEqual(JSON.parse(row.prescribed_observer_gateways), ['GwA', 'GwB', 'GwC']);
  assert.deepEqual(JSON.parse(row.prescribed_name_hashes), ['dead', 'beef']);
});

test('reward amounts round trip exactly at full precision', () => {
  const db = memoryDb();
  upsertEpochs(db, [epochAccount()], 1000, 500);

  const row = readEpoch(db)!;
  assert.equal(row.total_eligible_rewards, 70254840794);
  assert.equal(row.per_gateway_reward, 178424992);
  assert.equal(row.per_observer_reward, 281019363);
});

test('several epochs in one cycle are each keyed separately', () => {
  const db = memoryDb();
  const result = upsertEpochs(
    db,
    [508, 509, 510].map((epochIndex) => epochAccount({ epochIndex }, `Pda${epochIndex}`)),
    1000,
    500
  );

  assert.deepEqual(result, { inserted: 3, updated: 0, stale: 0 });
  assert.deepEqual(
    (db.prepare('SELECT epoch_index FROM epochs ORDER BY epoch_index').all() as {
      epoch_index: number;
    }[]).map((r) => r.epoch_index),
    [508, 509, 510]
  );
});
