/**
 * Operator earnings are inferred, not measured, so every test here is about
 * refusing to produce a number rather than producing one. A contaminated
 * inference looks exactly like a real reward.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import { deriveOperatorRewards } from '../src/rewards/operator.js';
import { detectStakeChanges } from '../src/rewards/stake-changes.js';

function db() {
  const handle = new BetterSqlite3(':memory:');
  applyMigrations(handle);
  return handle;
}

function sample(handle: BetterSqlite3.Database, epoch: number, staked: number, gateway = 'G1', operator = 'OP1') {
  handle
    .prepare(
      `INSERT INTO stake_samples (epoch_index, kind, address, gateway_address, staked, vaulted, sampled_at)
       VALUES (?, 'operator', ?, ?, ?, 0, 0)`
    )
    .run(epoch, operator, gateway, staked);
}

function flag(handle: BetterSqlite3.Database, epoch: number, instruction: string, gateway = 'G1', operator = 'OP1') {
  handle
    .prepare(
      `INSERT INTO stake_change_flags (epoch_index, kind, address, gateway_address, instruction, occurrences)
       VALUES (?, 'operator', ?, ?, ?, 1)`
    )
    .run(epoch, operator, gateway, instruction);
}

test('an undisturbed epoch yields the stake delta as the reward', () => {
  const handle = db();
  sample(handle, 523, 1_000);
  sample(handle, 524, 1_050);

  assert.deepEqual(deriveOperatorRewards(handle), [
    { epochIndex: 524, address: 'OP1', gatewayAddress: 'G1', reward: 50 },
  ]);
  handle.close();
});

test('the first sampled epoch has no predecessor and so no reward', () => {
  const handle = db();
  sample(handle, 523, 1_000);
  assert.deepEqual(deriveOperatorRewards(handle), [], 'nothing to subtract from');
  handle.close();
});

test('an epoch where the operator moved stake yields null, not a contaminated number', () => {
  const handle = db();
  sample(handle, 523, 1_000);
  sample(handle, 524, 26_000); // looks like a 25,000 reward; it was a deposit
  flag(handle, 524, 'JoinNetwork');

  const [row] = deriveOperatorRewards(handle);
  assert.equal(row.reward, null);
  assert.equal(row.reason, 'stake-changed');
  handle.close();
});

test('a withdrawal cannot be read as a negative reward', () => {
  const handle = db();
  sample(handle, 523, 1_000);
  sample(handle, 524, 400);
  // Even unflagged, a falling stake means a movement was missed. Reporting
  // -600, or clamping to 0, would both hide that.
  const [row] = deriveOperatorRewards(handle);
  assert.equal(row.reward, null);
  assert.equal(row.reason, 'negative-delta');
  handle.close();
});

test('non-adjacent samples do not have their gap silently summed', () => {
  const handle = db();
  sample(handle, 520, 1_000);
  sample(handle, 524, 1_400); // four epochs later
  const [row] = deriveOperatorRewards(handle);
  assert.equal(row.reward, null, '400 across four epochs is not one epoch of earning');
  assert.equal(row.reason, 'no-previous-sample');
  handle.close();
});

test('positions are derived independently of one another', () => {
  const handle = db();
  sample(handle, 523, 1_000, 'G1', 'OP1');
  sample(handle, 524, 1_050, 'G1', 'OP1');
  sample(handle, 523, 500, 'G2', 'OP2');
  sample(handle, 524, 9_000, 'G2', 'OP2');
  flag(handle, 524, 'JoinNetwork', 'G2', 'OP2');

  const rows = deriveOperatorRewards(handle).sort((a, b) => a.address < b.address ? -1 : 1);
  assert.equal(rows[0].reward, 50, "OP1's clean epoch is unaffected by OP2's deposit");
  assert.equal(rows[1].reward, null);
  handle.close();
});

// --- attribution ---

const operatorOf = (gw: string) => (gw === 'G1' ? 'OP1' : gw === 'G2' ? 'OP2' : null);

test('a stake change is attributed only when the operator signed it', () => {
  const flags = detectStakeChanges(
    {
      logMessages: ['Program log: Instruction: DecreaseOperatorStake'],
      accountKeys: ['OP1', 'G1', 'somethingelse'],
    },
    operatorOf
  );
  assert.deepEqual(flags, [
    { kind: 'operator', address: 'OP1', gatewayAddress: 'G1', instruction: 'DecreaseOperatorStake' },
  ]);
});

test('a gateway merely mentioned by another signer is NOT flagged', () => {
  // The exact failure that invalidated an earlier attribution: the account
  // cranking epoch distribution is itself a gateway operator, so its gateway
  // appeared in every payout it submitted — 30 of 30 sampled.
  const flags = detectStakeChanges(
    {
      logMessages: ['Program log: Instruction: DecreaseOperatorStake'],
      accountKeys: ['OP2', 'G1'], // OP2 signs; G1 belongs to OP1
      },
    operatorOf
  );
  assert.deepEqual(flags, [], 'G1 was mentioned, not moved by its own operator');
});

test('only stake-moving instructions flag anything', () => {
  for (const instruction of ['ReleaseTreasuryToRecipient', 'DistributeEpoch', 'TallyWeights']) {
    assert.deepEqual(
      detectStakeChanges(
        { logMessages: [`Program log: Instruction: ${instruction}`], accountKeys: ['OP1', 'G1'] },
        operatorOf
      ),
      [],
      `${instruction} does not move an operator's stake`
    );
  }
});

test('each affected gateway is flagged once, not once per account mention', () => {
  const flags = detectStakeChanges(
    {
      logMessages: ['Program log: Instruction: ClaimWithdrawal'],
      accountKeys: ['OP1', 'G1', 'G1', 'G1'],
    },
    operatorOf
  );
  assert.equal(flags.length, 1);
});

// --- document bounds ---

import { buildRewardsDocument, REWARDS_WINDOW_EPOCHS } from '../src/rewards/document.js';

test('the per-epoch window is bounded but lifetime totals are not', () => {
  // Left unbounded these arrays project to ~12.5 MB after a year of daily
  // epochs, which every consumer would download to read one row.
  const epochs = Array.from({ length: 100 }, (_, i) => 400 + i);
  const rows = epochs.map((epochIndex) => ({
    epochIndex, delegate: 'D1', gateway: 'G1', amount: 10,
  }));

  const doc = buildRewardsDocument(epochs, () => 1, rows, [], new Date(0).toISOString());

  assert.equal(doc.epochs.length, REWARDS_WINDOW_EPOCHS, 'window is capped');
  assert.equal(doc.totalEpochsRecorded, 100, 'but the document says how much exists');
  assert.equal(doc.epochs[doc.epochs.length - 1], 499, 'the window is the most RECENT epochs');

  const [position] = doc.positions;
  assert.equal(position.rewards.length, REWARDS_WINDOW_EPOCHS);
  assert.equal(position.windowRewards, 10 * REWARDS_WINDOW_EPOCHS, 'window sum');
  assert.equal(position.lifetimeRewards, 1_000, 'lifetime covers all 100 epochs, untruncated');
  assert.equal(position.epochsRewarded, 100);
  assert.equal(doc.totals.delegateRewards, 1_000, 'totals are lifetime, not windowed');
});

test('a position that earned only outside the window keeps its lifetime total', () => {
  const epochs = Array.from({ length: 60 }, (_, i) => 400 + i);
  // Credited once, 60 epochs ago — long outside a 30-epoch window.
  const doc = buildRewardsDocument(
    epochs, () => 1,
    [{ epochIndex: 400, delegate: 'D1', gateway: 'G1', amount: 777 }],
    [], new Date(0).toISOString()
  );

  const [position] = doc.positions;
  assert.equal(position.lifetimeRewards, 777, 'still visible as lifetime earnings');
  assert.equal(position.windowRewards, 0);
  assert.deepEqual(
    position.rewards.filter((r) => r !== null), [],
    'and correctly absent from the windowed chart'
  );
});
