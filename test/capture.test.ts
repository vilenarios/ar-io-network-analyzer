/**
 * Capture-side guards: how a cycle is judged, and what decode refuses.
 *
 * No RPC endpoint is contacted anywhere in this file. `decodeObservationAccount`
 * is exercised against synthetic 469-byte accounts through an injected decoder,
 * and the cycle classifier is a pure function by design.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import {
  classifyCycle,
  isHealthyStatus,
  isUnhealthyStatus,
  type CycleSignals,
} from '../src/capture/status.js';
import {
  MAX_GATEWAY_COUNT,
  decodeObservationAccount,
  isValidGatewayCount,
  useSdkDecoder,
  type SdkObservation,
} from '../src/capture/decode.js';
import { OBSERVATION_ACCOUNT_BYTES, OBSERVATION_DISCRIMINATOR_B64 } from '../src/capture/rpc.js';
import { holderIsDead } from '../src/capture/lock.js';
import { epochsNeedingRegistry, seedState } from '../src/capture/daemon.js';
import { GATEWAY_COUNT, blob, memoryDb } from './helpers.js';

const healthy: CycleSignals = {
  accountCount: 33,
  decodedCount: 33,
  isStale: false,
  layoutDrift: false,
  duplicateKeys: 0,
};

test('a normal cycle is ok', () => {
  assert.deepEqual(classifyCycle(healthy), { status: 'ok', anomaly: null });
  assert.equal(isHealthyStatus('ok'), true);
  assert.equal(isUnhealthyStatus('ok'), false);
});

test('ZERO ACCOUNTS is an anomaly, never a success', () => {
  // This is the blackout case: the dataSize filter stops matching after an
  // account layout change, the RPC call still succeeds, and every subsequent
  // cycle captures nothing while close_observation deletes the originals.
  const result = classifyCycle({ ...healthy, accountCount: 0, decodedCount: 0 });

  assert.equal(result.status, 'anomaly');
  assert.equal(result.anomaly, 'ZERO_ACCOUNTS');
  assert.equal(isHealthyStatus(result.status), false, 'health surfaces must go red');
  assert.equal(isUnhealthyStatus(result.status), true, 'and it must count toward the alarm');
});

test('the layout canary outranks everything else', () => {
  const result = classifyCycle({ ...healthy, accountCount: 0, decodedCount: 0, layoutDrift: true });
  assert.equal(result.status, 'anomaly');
  assert.equal(result.anomaly, 'LAYOUT_DRIFT');
});

test('accounts that all fail to decode are an anomaly', () => {
  const result = classifyCycle({ ...healthy, decodedCount: 0 });
  assert.equal(result.anomaly, 'ALL_ACCOUNTS_UNPARSED');
});

test('duplicate observer keys are an anomaly', () => {
  const result = classifyCycle({ ...healthy, duplicateKeys: 1 });
  assert.equal(result.anomaly, 'DUPLICATE_OBSERVER_KEYS');
});

test('a lagging replica is stale — degraded but not unhealthy', () => {
  const result = classifyCycle({ ...healthy, isStale: true });
  assert.deepEqual(result, { status: 'stale', anomaly: null });
  assert.equal(isHealthyStatus('stale'), true);
  assert.equal(isUnhealthyStatus('stale'), false);
  assert.equal(isUnhealthyStatus('failed'), true);
  assert.equal(isUnhealthyStatus('anomaly'), true);
});

/** A synthetic Observation account with the real byte layout. */
function syntheticAccount(options: { gatewayCount?: number; discriminator?: Buffer } = {}): Buffer {
  const data = Buffer.alloc(OBSERVATION_ACCOUNT_BYTES, 0);
  (options.discriminator ?? Buffer.from(OBSERVATION_DISCRIMINATOR_B64, 'base64')).copy(data, 0);
  blob(0xa5).copy(data, 48);
  data.writeUInt16LE(options.gatewayCount ?? GATEWAY_COUNT, 423);
  data.writeUInt8(1, 466); // schema major
  return data;
}

/** A decoder that reads the same bytes the raw slice does. */
function installDecoder(overrides: Partial<SdkObservation> = {}): void {
  useSdkDecoder((data: Buffer) => ({
    epochIndex: 511,
    observer: 'observer-1',
    gatewayResults: Buffer.from(data.subarray(48, 423)),
    gatewayCount: data.readUInt16LE(423),
    reportTxId: 'wE408GNPPIoTbRJEDfI0dm6dsklhE32zgdoCc2C1YKw',
    submittedAt: 1_760_000_000,
    ...overrides,
  }));
}

test('a well-formed account decodes with provenance attached', () => {
  installDecoder();
  const outcome = decodeObservationAccount({ pubkey: 'PDA', data: syntheticAccount() });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.record.gatewayCount, GATEWAY_COUNT);
  assert.equal(outcome.record.gatewayResults.length, 375);
  assert.equal(outcome.record.accountBytes, OBSERVATION_ACCOUNT_BYTES);
  assert.equal(outcome.record.pubkey, 'PDA');
  assert.deepEqual(outcome.record.schemaVersion, { major: 1, minor: 0, patch: 0 });
  assert.equal(outcome.record.suspectTimestamp, false);
  useSdkDecoder(null);
});

test('decode refuses a gatewayCount that cannot address the blob', () => {
  installDecoder();

  for (const gatewayCount of [0, MAX_GATEWAY_COUNT + 1, 65535]) {
    const outcome = decodeObservationAccount({
      pubkey: 'PDA',
      data: syntheticAccount({ gatewayCount }),
    });
    assert.equal(outcome.ok, false, `gatewayCount ${gatewayCount} must not be trusted`);
    if (outcome.ok) return;
    assert.match(outcome.reason, /^gateway_count_out_of_range:/);
  }

  assert.equal(isValidGatewayCount(1), true);
  assert.equal(isValidGatewayCount(MAX_GATEWAY_COUNT), true);
  assert.equal(isValidGatewayCount(0), false);
  assert.equal(isValidGatewayCount(-1), false);
  assert.equal(isValidGatewayCount(1.5), false);
  assert.equal(isValidGatewayCount(Number.NaN), false);
  useSdkDecoder(null);
});

test('decode refuses the wrong size, the wrong discriminator, and a moved blob', () => {
  installDecoder();

  const short = decodeObservationAccount({ pubkey: 'PDA', data: Buffer.alloc(468) });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.reason, 'unexpected_account_size:468');

  const wrongDisc = decodeObservationAccount({
    pubkey: 'PDA',
    data: syntheticAccount({ discriminator: Buffer.alloc(8, 0xff) }),
  });
  assert.equal(wrongDisc.ok, false);
  if (!wrongDisc.ok) assert.match(wrongDisc.reason, /^discriminator_mismatch:/);

  // The SDK and the raw slice disagreeing means the layout moved under us.
  installDecoder({ gatewayResults: Buffer.alloc(375, 0x01) });
  const moved = decodeObservationAccount({ pubkey: 'PDA', data: syntheticAccount() });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.reason, 'gateway_results_offset_mismatch');

  useSdkDecoder(null);
});

test('a decode failure is a value, never a throw', () => {
  useSdkDecoder(() => {
    throw new TypeError('borsh exploded');
  });

  const outcome = decodeObservationAccount({ pubkey: 'PDA', data: syntheticAccount() });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'deserialize_failed:TypeError');
  useSdkDecoder(null);
});

test('a far-future submittedAt is flagged, not discarded', () => {
  installDecoder({ submittedAt: Math.floor(Date.now() / 1000) + 10 * 86400 });
  const outcome = decodeObservationAccount({ pubkey: 'PDA', data: syntheticAccount() });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.record.suspectTimestamp, true);
  useSdkDecoder(null);
});

test('the hardcoded discriminator is the Anchor derivation', () => {
  const derived = createHash('sha256').update('account:Observation').digest().subarray(0, 8);
  assert.equal(derived.toString('base64'), OBSERVATION_DISCRIMINATOR_B64);
});

test('daemon state is seeded from the database, not from zero', () => {
  const db = memoryDb();

  // Fresh file: nothing to learn from.
  const cold = seedState(db);
  assert.equal(cold.lastContextSlot, 0);
  assert.equal(cold.lastCanaryAt, 0);

  db.prepare(
    `INSERT INTO poll_runs (started_at, status, context_slot, canary_count)
     VALUES (1000, 'ok', 900, 33)`
  ).run();
  db.prepare(
    `INSERT INTO poll_runs (started_at, status, context_slot, canary_count)
     VALUES (2000, 'ok', 950, NULL)`
  ).run();

  const warm = seedState(db);
  assert.equal(warm.lastContextSlot, 950, 'stale-replica detection works on the first cycle');
  assert.equal(warm.lastCanaryAt, 1000, 'the hourly canary stays hourly across restarts');
  db.close();
});

test('only the live epoch can have an approximate slot order upgraded', () => {
  const db = memoryDb();
  const insert = db.prepare(
    `INSERT INTO registry_snapshots
       (epoch_index, gateway_count, captured_at, captured_at_slot, registry_pubkey, digest, in_epoch)
     VALUES (?, 2, 1, 1, 'REG', 'digest', ?)`
  );
  insert.run(510, 0); // closed epoch, approximate order — unfixable, leave it
  insert.run(511, 1); // already authoritative

  // 513 has no snapshot at all; 512 is live with an approximate one.
  insert.run(512, 0);

  assert.deepEqual(epochsNeedingRegistry(db, [510, 511, 512, 513], 512), [512, 513]);
  // Once the live epoch's snapshot is authoritative, nothing is re-fetched.
  db.prepare('UPDATE registry_snapshots SET in_epoch = 1 WHERE epoch_index = 512').run();
  assert.deepEqual(epochsNeedingRegistry(db, [510, 511, 512], 512), []);
  db.close();
});

test('holderIsDead only ever speaks about this host', () => {
  assert.equal(holderIsDead({ pid: process.pid, host: 'me' }, 'me'), false, 'never self');
  assert.equal(holderIsDead({ pid: 999_999, host: 'other' }, 'me'), false, 'pids are not portable');
  // A pid that cannot exist on this host, recorded by this host.
  assert.equal(holderIsDead({ pid: 0x7ffffff0, host: 'me' }, 'me'), true);
});
