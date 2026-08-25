/**
 * Stake retention has a failure mode the economics series does not: a missed
 * epoch is gone forever, because stake credits land in PDA state and PDA state
 * has no per-transaction history. So these tests care as much about NOT losing
 * a sample as about not fabricating one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyMigrations } from '../src/db/migrations.js';
import { readStakePositions, type StakeSnapshot } from '../src/rewards/inputs.js';
import {
  epochsAwaitingStakeSample,
  sampleStakePositions,
} from '../src/rewards/sample.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function db() {
  const handle = new BetterSqlite3(':memory:');
  applyMigrations(handle);
  return handle;
}

function addEpoch(handle: BetterSqlite3.Database, epochIndex: number, endedMsAgo: number, distributed = 1) {
  handle
    .prepare(
      `INSERT INTO epochs (epoch_index, end_timestamp, rewards_distributed,
                           total_eligible_rewards, account_bytes, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`
    )
    .run(epochIndex, Math.floor((NOW - endedMsAgo) / 1000), distributed, NOW - endedMsAgo, NOW - endedMsAgo);
}

const snapshot = (staked: number): StakeSnapshot => ({
  observedAt: NOW - 5 * 60 * 1000,
  positions: [
    { kind: 'operator', address: 'OP1', gatewayAddress: 'OP1', staked, vaulted: 0, startTimestamp: 1 },
    { kind: 'delegate', address: 'DEL1', gatewayAddress: 'OP1', staked: staked * 2, vaulted: 0, startTimestamp: 2 },
    // Same wallet, a second gateway: a distinct position that earns separately.
    { kind: 'delegate', address: 'DEL1', gatewayAddress: 'OP2', staked: 7, vaulted: 0, startTimestamp: 3 },
  ],
});

test('operators are retained, not just delegates', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  await sampleStakePositions(handle, async () => snapshot(100), { now: NOW });

  const kinds = handle
    .prepare('SELECT kind, COUNT(*) c FROM stake_samples GROUP BY kind')
    .all() as { kind: string; c: number }[];
  assert.deepEqual(
    Object.fromEntries(kinds.map((k) => [k.kind, k.c])),
    { operator: 1, delegate: 2 },
    'operators hold 8.7M ARIO of stake and earn too — omitting them was the first scoping miss'
  );
  handle.close();
});

test('one wallet delegating to two gateways is two positions', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);
  await sampleStakePositions(handle, async () => snapshot(100), { now: NOW });

  const rows = handle
    .prepare("SELECT gateway_address, staked FROM stake_samples WHERE address='DEL1' ORDER BY gateway_address")
    .all() as { gateway_address: string; staked: number }[];
  assert.deepEqual(rows, [
    { gateway_address: 'OP1', staked: 200 },
    { gateway_address: 'OP2', staked: 7 },
  ]);
  handle.close();
});

test('a sample is written once and never revised', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  const first = await sampleStakePositions(handle, async () => snapshot(100), { now: NOW });
  const second = await sampleStakePositions(handle, async () => snapshot(999), { now: NOW });

  assert.deepEqual(first.sampled, [523]);
  assert.deepEqual(second.sampled, [], 're-running must be a no-op');
  const staked = handle
    .prepare("SELECT staked FROM stake_samples WHERE kind='operator'")
    .get() as { staked: number };
  assert.equal(staked.staked, 100, 'the original observation must survive');
  handle.close();
});

test('a missing snapshot skips the epoch and leaves it pending to retry', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  const result = await sampleStakePositions(handle, async () => null, { now: NOW });

  assert.deepEqual(result.sampled, []);
  assert.deepEqual(result.skipped, [523]);
  const count = handle.prepare('SELECT COUNT(*) c FROM stake_samples').get() as { c: number };
  assert.equal(count.c, 0);
  // Critically it must still be pending: silently dropping it loses the epoch
  // permanently, because stake at a past epoch cannot be recovered.
  assert.deepEqual(epochsAwaitingStakeSample(handle, NOW), [523], 'must retry, not give up');
  handle.close();
});

test('an epoch that has not distributed is not sampled yet', () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR, /* distributed */ 0);
  assert.deepEqual(epochsAwaitingStakeSample(handle, NOW), []);
  handle.close();
});

test('today\'s stakes are never attributed to long-past epochs', () => {
  const handle = db();
  for (let i = 0; i < 6; i++) addEpoch(handle, 500 + i, (10 - i) * 24 * HOUR);
  addEpoch(handle, 523, 2 * HOUR);

  assert.deepEqual(
    epochsAwaitingStakeSample(handle, NOW),
    [523],
    'a stake observed today did not exist at an epoch a week ago'
  );
  handle.close();
});

test('positions are read from the portal snapshot, costing no RPC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-inputs-'));
  mkdirSync(join(dir, 'api/v1/portal'), { recursive: true });
  const generatedAt = new Date(NOW - 60_000).toISOString();

  writeFileSync(
    join(dir, 'api/v1/portal/gateways.json'),
    JSON.stringify({
      generatedAt,
      items: [
        { gatewayAddress: 'G1', operator: 'OP1', operatorStake: 500, startTimestamp: 10, status: 'joined' },
        // A gateway that left still has earnings worth showing.
        { gatewayAddress: 'G2', operator: 'OP2', operatorStake: 5, startTimestamp: 11, status: 'leaving' },
      ],
    })
  );
  writeFileSync(
    join(dir, 'api/v1/portal/delegates.json'),
    JSON.stringify({
      generatedAt,
      items: [{ address: 'D1', gatewayAddress: 'G1', delegatedStake: 300, vaultedStake: 20, startTimestamp: 12 }],
    })
  );

  const snap = readStakePositions(dir, NOW);
  assert.ok(snap);
  assert.equal(snap.positions.length, 3, 'two operators and one delegation');
  assert.equal(snap.observedAt, Date.parse(generatedAt));
  const op = snap.positions.find((p) => p.address === 'OP1');
  assert.deepEqual(op, {
    kind: 'operator', address: 'OP1', gatewayAddress: 'G1',
    staked: 500, vaulted: 0, startTimestamp: 10,
  });
  rmSync(dir, { recursive: true, force: true });
});

test('a stale portal snapshot is refused rather than misattributed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-stale-'));
  mkdirSync(join(dir, 'api/v1/portal'), { recursive: true });
  const fresh = new Date(NOW - 60_000).toISOString();
  const old = new Date(NOW - 3 * HOUR).toISOString();

  writeFileSync(join(dir, 'api/v1/portal/gateways.json'),
    JSON.stringify({ generatedAt: fresh, items: [{ gatewayAddress: 'G1', operator: 'O', operatorStake: 1 }] }));
  // Only the delegates half is stale — the pair is only as current as its
  // stalest side, so the whole snapshot must be refused.
  writeFileSync(join(dir, 'api/v1/portal/delegates.json'),
    JSON.stringify({ generatedAt: old, items: [] }));

  assert.equal(readStakePositions(dir, NOW), null);
  rmSync(dir, { recursive: true, force: true });
});

test('two settled epochs are never given the same observed stake', () => {
  const handle = db();
  // Exactly the shape that broke it: 523 ended 17h ago, 522 ended 41h ago, and
  // a 48h window happily claimed both — writing one observation to two epochs
  // and manufacturing a zero delta between them.
  addEpoch(handle, 522, 41 * HOUR);
  addEpoch(handle, 523, 17 * HOUR);

  assert.deepEqual(
    epochsAwaitingStakeSample(handle, NOW),
    [523],
    'only the epoch the observation can actually speak for'
  );
  handle.close();
});
