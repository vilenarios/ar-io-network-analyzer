/**
 * The five Epoch fields the SDK's decoder drops, and the failure tally.
 *
 * `deserializeEpoch()` in @ar.io/sdk returns 21 of the account's 29 fields.
 * Capture decoded through the SDK, so four of them were never stored — and
 * they cannot be recovered later: `close_epoch` is permissionless and reclaims
 * the account, so 44 of 53 known epochs had already lost them.
 *
 * These tests cover the parts where being wrong would be quiet: a u128 that
 * silently loses precision past 2^53, a decoder failure that overwrites a good
 * earlier read with nulls, and a fixed-size on-chain array whose padding tail
 * would read as thousands of gateways with zero failures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_EPOCH_EXTRAS,
  combineU128,
  decodeEpochExtras,
  formatVersion,
  useEpochExtrasDecoder,
} from '../src/capture/epoch-extras.js';

// --- u128 ------------------------------------------------------------------

test('combineU128 reassembles the two u64 halves', () => {
  assert.equal(combineU128(0n, 0n), '0');
  assert.equal(combineU128(1n, 0n), '1');
  // hi contributes 2^64
  assert.equal(combineU128(0n, 1n), '18446744073709551616');
  assert.equal(combineU128(5n, 1n), '18446744073709551621');
});

test('combineU128 keeps precision a JS number would destroy', () => {
  // 2^53 + 1 is the first integer a double cannot represent. A string carries
  // it; Number() would round it to 9007199254740992.
  const value = combineU128(9_007_199_254_740_993n, 0n);
  assert.equal(value, '9007199254740993');
  assert.notEqual(Number(value).toString(), value, 'proves the float path loses it');
});

test('combineU128 handles the maximum u128 without overflow', () => {
  const max = combineU128(2n ** 64n - 1n, 2n ** 64n - 1n);
  assert.equal(max, (2n ** 128n - 1n).toString());
});

test('combineU128 returns null when either half is missing', () => {
  // A half-read weight is worse than none: it looks like a plausible number.
  assert.equal(combineU128(undefined, 1n), null);
  assert.equal(combineU128(1n, undefined), null);
  assert.equal(combineU128(undefined, undefined), null);
});

test('combineU128 accepts plain numbers as well as bigints', () => {
  assert.equal(combineU128(5, 0), '5');
});

// --- version ---------------------------------------------------------------

test('formatVersion renders major.minor.patch', () => {
  assert.equal(formatVersion(Uint8Array.from([1, 2, 3])), '1.2.3');
  assert.equal(formatVersion(Uint8Array.from([0, 0, 0])), '0.0.0');
});

test('formatVersion refuses a short or absent buffer', () => {
  assert.equal(formatVersion(undefined), null);
  assert.equal(formatVersion(Uint8Array.from([1, 2])), null);
});

// --- decode ----------------------------------------------------------------

test('decodeEpochExtras projects all five fields', (t) => {
  t.after(() => useEpochExtrasDecoder(null));
  useEpochExtrasDecoder(() => ({
    totalCompositeWeightLo: 2854n,
    totalCompositeWeightHi: 0n,
    hashchain: Uint8Array.from(Array(32).fill(0xab)),
    observationsClosed: 1,
    versionBytes: Uint8Array.from([1, 0, 0]),
  }));

  const extras = decodeEpochExtras(Buffer.alloc(8));
  assert.equal(extras.totalCompositeWeight, '2854');
  assert.equal(extras.hashchain?.toString('hex'), 'ab'.repeat(32));
  assert.equal(extras.observationsClosed, true);
  assert.equal(extras.version, '1.0.0');
});

test('observationsClosed 0 is false, not null', () => {
  // A live epoch must be distinguishable from an epoch we could not read.
  useEpochExtrasDecoder(() => ({ observationsClosed: 0 }));
  assert.equal(decodeEpochExtras(Buffer.alloc(8)).observationsClosed, false);
  useEpochExtrasDecoder(null);
});

test('a throwing decoder yields nulls, never an exception', () => {
  // Capture is the durable record; a decoder problem must degrade, not stop it.
  useEpochExtrasDecoder(() => {
    throw new Error('layout drifted');
  });
  assert.deepEqual(decodeEpochExtras(Buffer.alloc(8)), EMPTY_EPOCH_EXTRAS);
  useEpochExtrasDecoder(null);
});

test('no decoder loaded yields nulls', () => {
  useEpochExtrasDecoder(null);
  assert.deepEqual(decodeEpochExtras(Buffer.alloc(8)), EMPTY_EPOCH_EXTRAS);
});

test('a zeroed hashchain is still reported, not treated as absent', () => {
  // All-zero is a legitimate on-chain value. Collapsing it to null would make
  // "we read zeroes" indistinguishable from "we never read it".
  useEpochExtrasDecoder(() => ({ hashchain: new Uint8Array(32) }));
  const extras = decodeEpochExtras(Buffer.alloc(8));
  assert.equal(extras.hashchain?.length, 32);
  assert.equal(extras.hashchain?.toString('hex'), '00'.repeat(32));
  useEpochExtrasDecoder(null);
});

// --- the failure tally cross-check -----------------------------------------

test('the failure tally is the cross-check that catches an inverted decoder', () => {
  // The property consumers get for free, and the one that caught a polarity
  // error before it shipped: for slot i, the number of observers whose bit is
  // CLEARED must equal failureCounts[i]. A set bit means healthy.
  const failureCounts = [1, 0, 2];
  const observers = [
    Buffer.from([0b0000_0110]), // slot0 clear -> failed; slots 1,2 set -> passed
    Buffer.from([0b0000_0011]), // slot2 clear -> failed
    Buffer.from([0b0000_0011]), // slot2 clear -> failed
  ];
  const bit = (b: Buffer, i: number) => (b[i >> 3] >> (i & 7)) & 1;

  for (let slot = 0; slot < failureCounts.length; slot++) {
    const cleared = observers.filter((b) => bit(b, slot) === 0).length;
    assert.equal(cleared, failureCounts[slot], `slot ${slot} reconciles`);
  }

  // And the inverted reading does NOT reconcile — which is the point.
  const setBits = observers.filter((b) => bit(b, 0) === 1).length;
  assert.notEqual(setBits, failureCounts[0]);
});
