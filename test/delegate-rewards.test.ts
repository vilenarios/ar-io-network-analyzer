/**
 * Delegate rewards are decoded from on-chain events, so the risks are decoding
 * and attribution rather than fabrication: a misread byte range or a one-epoch
 * shift produces confident, plausible, wrong earnings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import { decodeRewardEvents, encodeBase58 } from '../src/rewards/events.js';
import {
  epochForRewardAt,
  epochsAwaitingRewardScan,
  scanDelegateRewards,
  type ScanDeps,
} from '../src/rewards/scan.js';

/** A real event captured from mainnet, used verbatim as the decoding fixture. */
const LIVE_EVENT =
  'DfkeI0mXukKyVo/ahFz7TUSIu75eVCHf2X6o+7x64SWfoAHCBZ5MLTchP/+wrfKXZIGDWFfT9zquc2/LBsHhp0VAIFPizZoor0MKAAAAAAC95IxqAAAAAA==';

function db() {
  const handle = new BetterSqlite3(':memory:');
  applyMigrations(handle);
  return handle;
}

function addEpoch(handle: BetterSqlite3.Database, epochIndex: number, endIso: string) {
  const seconds = Math.floor(Date.parse(endIso) / 1000);
  handle
    .prepare(
      `INSERT INTO epochs (epoch_index, end_timestamp, rewards_distributed,
                           total_eligible_rewards, account_bytes, first_seen_at, last_seen_at)
       VALUES (?, ?, 1, 0, 0, ?, ?)`
    )
    .run(epochIndex, seconds, seconds * 1000, seconds * 1000);
}

test('a real mainnet event decodes to the values it was verified against', () => {
  const [event] = decodeRewardEvents([`Program data: ${LIVE_EVENT}`]);

  assert.equal(event.delegate, 'D1A8JtxtRmrNBbH831xRg5KofBnMTh86XBCtF3ft5kTn');
  assert.equal(event.gateway, '4iCq8az7z32mn3nu5WXajfC2mAcbprkRW7bDUEWURDd1');
  assert.equal(event.amount, 672_687, '0.672687 ARIO');
  assert.equal(new Date(event.at * 1000).toISOString(), '2026-08-25T00:41:33.000Z');
});

test('unrelated program output is ignored, not guessed at', () => {
  assert.deepEqual(
    decodeRewardEvents([
      'Program log: Instruction: TallyWeights',
      // Right prefix, wrong length — a different event, or a future one.
      'Program data: DfkeI0mXukIAAAAA',
      // The epoch summary DistributeEpoch emits: 36 bytes, no pubkeys.
      'Program data: 2hg5M9drNBELAgAAAAAAAIQCAAAUo56ODwAAADfhjGoAAAAA',
      'Program data: not-valid-base64!!',
    ]),
    [],
    'only the exact discriminator and length may be decoded'
  );
});

test('base58 keeps leading zero bytes as 1s', () => {
  assert.equal(encodeBase58(Buffer.alloc(32)), '1'.repeat(32));
  assert.equal(encodeBase58(Buffer.from([0, 0, 1])), '112');
});

test('a reward belongs to the epoch that ENDED before it, not the one containing it', () => {
  // Rewards for epoch 523 are compounded at 00:41, after 523's 00:04 boundary
  // and inside what is already epoch 524. Attributing by containment would
  // credit every reward to the following epoch.
  const boundaries = [
    { epochIndex: 522, endSeconds: Date.parse('2026-08-24T00:04:10Z') / 1000 },
    { epochIndex: 523, endSeconds: Date.parse('2026-08-25T00:04:10Z') / 1000 },
  ];

  assert.equal(epochForRewardAt(boundaries, Date.parse('2026-08-25T00:41:33Z') / 1000), 523);
  // Just before 523 closed, so it is still 522's reward.
  assert.equal(epochForRewardAt(boundaries, Date.parse('2026-08-25T00:04:09Z') / 1000), 522);
  // Exactly on the boundary counts as the epoch that just ended.
  assert.equal(epochForRewardAt(boundaries, Date.parse('2026-08-25T00:04:10Z') / 1000), 523);
  // Before any known epoch ended.
  assert.equal(epochForRewardAt(boundaries, Date.parse('2026-08-01T00:00:00Z') / 1000), null);
});

function deps(logsBySignature: Record<string, string[]>, errored: string[] = []): ScanDeps {
  return {
    listSignatures: async () =>
      Object.keys(logsBySignature).map((signature) => ({
        signature,
        blockTime: Date.parse('2026-08-25T00:41:33Z') / 1000,
        err: errored.includes(signature) ? { InstructionError: [0, 'Custom'] } : null,
      })),
    logsFor: async (signature) =>
      logsBySignature[signature]
        ? { logMessages: logsBySignature[signature], accountKeys: [] }
        : null,
  };
}

/** Build an event for a specific delegation and amount. */
function eventFor(delegate: string, gateway: string, amount: number, at: number): string {
  const b = Buffer.alloc(88);
  Buffer.from('0df91e234997ba42', 'hex').copy(b, 0);
  Buffer.from(delegate.padEnd(32, '\0')).copy(b, 8, 0, 32);
  Buffer.from(gateway.padEnd(32, '\0')).copy(b, 40, 0, 32);
  b.writeBigUInt64LE(BigInt(amount), 72);
  b.writeBigUInt64LE(BigInt(at), 80);
  return `Program data: ${b.toString('base64')}`;
}

test('several credits to one delegation in an epoch are summed', async () => {
  const handle = db();
  addEpoch(handle, 523, '2026-08-25T00:04:10Z');
  const at = Date.parse('2026-08-25T00:41:33Z') / 1000;
  const D = encodeBase58(Buffer.from('DELEGATE'.padEnd(32, '\0'))); // decoded form
  void D;

  await scanDelegateRewards(
    handle,
    deps({
      s1: [eventFor('DELEGATE', 'GATEWAY', 100, at)],
      s2: [eventFor('DELEGATE', 'GATEWAY', 250, at + 5)],
    }),
    [523]
  );

  const row = handle
    .prepare('SELECT amount, event_count, first_at, last_at FROM delegate_rewards')
    .get() as { amount: number; event_count: number; first_at: number; last_at: number };
  assert.equal(row.amount, 350, 'a delegation credited twice earned the sum');
  assert.equal(row.event_count, 2);
  assert.equal(row.last_at - row.first_at, 5);
  handle.close();
});

test('failed transactions credit nothing', async () => {
  const handle = db();
  addEpoch(handle, 523, '2026-08-25T00:04:10Z');
  const at = Date.parse('2026-08-25T00:41:33Z') / 1000;

  await scanDelegateRewards(
    handle,
    deps({ ok: [eventFor('A', 'G', 100, at)], bad: [eventFor('A', 'G', 999, at)] }, ['bad']),
    [523]
  );

  const row = handle.prepare('SELECT amount FROM delegate_rewards').get() as { amount: number };
  assert.equal(row.amount, 100);
  handle.close();
});

test('rescanning is idempotent rather than doubling', async () => {
  const handle = db();
  addEpoch(handle, 523, '2026-08-25T00:04:10Z');
  const at = Date.parse('2026-08-25T00:41:33Z') / 1000;
  const d = deps({ s1: [eventFor('A', 'G', 100, at)] });

  await scanDelegateRewards(handle, d, [523]);
  await scanDelegateRewards(handle, d, [523]);

  const row = handle.prepare('SELECT amount FROM delegate_rewards').get() as { amount: number };
  assert.equal(row.amount, 100, 'immutable logs rescan to the same total');
  handle.close();
});

test('an epoch scanned with no rewards is recorded as scanned, not skipped', async () => {
  const handle = db();
  addEpoch(handle, 523, '2026-08-25T00:04:10Z');

  await scanDelegateRewards(handle, deps({ s1: ['Program log: Instruction: TallyWeights'] }), [523]);

  const scan = handle
    .prepare('SELECT events FROM delegate_reward_scans WHERE epoch_index = 523')
    .get() as { events: number };
  assert.equal(scan.events, 0);
  assert.deepEqual(
    epochsAwaitingRewardScan(handle),
    [],
    '"scanned and empty" must not look like "never scanned", which reads as earned nothing'
  );
  handle.close();
});

test('events outside the requested epochs are not half-recorded', async () => {
  const handle = db();
  addEpoch(handle, 522, '2026-08-24T00:04:10Z');
  addEpoch(handle, 523, '2026-08-25T00:04:10Z');

  await scanDelegateRewards(
    handle,
    deps({
      s1: [eventFor('A', 'G', 100, Date.parse('2026-08-25T00:41:33Z') / 1000)],
      s2: [eventFor('A', 'G', 555, Date.parse('2026-08-24T00:41:33Z') / 1000)],
    }),
    [523]
  );

  const rows = handle.prepare('SELECT epoch_index, amount FROM delegate_rewards').all();
  assert.deepEqual(rows, [{ epoch_index: 523, amount: 100 }], 'epoch 522 was not requested');
  handle.close();
});
