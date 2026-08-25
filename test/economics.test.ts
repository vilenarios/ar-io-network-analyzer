/**
 * The economics series is a time series, which means its failure modes are
 * quiet. A fabricated row does not throw; it produces a plausible number whose
 * delta is wrong, and every consumer downstream inherits that silently.
 *
 * These tests cover the rules that protect against exactly that, and each one
 * was written against a failure actually observed while building this: the
 * first implementation backfilled eight epochs with one balance, producing
 * seven consecutive zero deltas indistinguishable from "the protocol earned
 * nothing for a week".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import {
  epochsAwaitingEconomicsSample,
  listEconomicsSamples,
} from '../src/db/repo-read.js';
import { sampleEconomics, type EconomicsInputs } from '../src/economics/sample.js';
import { buildEconomicsDocument } from '../src/economics/document.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function db() {
  const handle = new BetterSqlite3(':memory:');
  applyMigrations(handle);
  return handle;
}

/** `end_timestamp` is stored in SECONDS — the schema's unit, not ms. */
function addEpoch(
  handle: BetterSqlite3.Database,
  epochIndex: number,
  endedMsAgo: number,
  distributed = 1,
  eligible = 1_000
) {
  // account_bytes / first_seen_at / last_seen_at are NOT NULL in the epochs
  // table; irrelevant here but required for a valid row.
  handle
    .prepare(
      `INSERT INTO epochs (epoch_index, end_timestamp, rewards_distributed,
                           total_eligible_rewards, account_bytes,
                           first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      epochIndex,
      Math.floor((NOW - endedMsAgo) / 1000),
      distributed,
      eligible,
      NOW - endedMsAgo,
      NOW - endedMsAgo
    );
}

const inputs = (protocolBalance: number): EconomicsInputs => ({
  protocolBalance,
  circulating: 10,
  staked: 20,
  delegated: 30,
  demandFactor: 1.5,
  arnsRecordCount: 40,
  observedAt: NOW,
});

const noPrice = async () => null;

test('an epoch is not sampled until it has distributed', () => {
  const handle = db();
  addEpoch(handle, 500, 2 * HOUR, /* distributed */ 0);
  assert.deepEqual(epochsAwaitingEconomicsSample(handle, NOW), []);
  handle.close();
});

test('old epochs are never backfilled, however many are unsampled', () => {
  const handle = db();
  // The exact shape that broke it: a long tail of settled epochs, none sampled.
  for (let i = 0; i < 8; i++) addEpoch(handle, 500 + i, (10 - i) * 24 * HOUR);
  addEpoch(handle, 523, 2 * HOUR);

  const pending = epochsAwaitingEconomicsSample(handle, NOW);

  assert.deepEqual(
    pending,
    [523],
    'only the recently-ended epoch may be sampled — attributing the current ' +
      'balance to week-old epochs invents a flat series'
  );
  handle.close();
});

test('a sample is written once and never revised', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  const first = await sampleEconomics(handle, async () => inputs(1_000), {
    now: NOW,
    fetchPrice: noPrice,
  });
  const second = await sampleEconomics(handle, async () => inputs(9_999), {
    now: NOW,
    fetchPrice: noPrice,
  });

  assert.deepEqual(first.sampled, [523]);
  assert.deepEqual(second.sampled, [], 're-running must be a no-op');

  const series = listEconomicsSamples(handle);
  assert.equal(series.length, 1);
  assert.equal(series[0].protocolBalance, 1_000, 'the original value must survive');
  handle.close();
});

test('an unreadable balance produces a gap, never a fabricated row', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  const result = await sampleEconomics(handle, async () => null, {
    now: NOW,
    fetchPrice: noPrice,
  });

  assert.deepEqual(result.sampled, []);
  assert.deepEqual(result.skipped, [523]);
  assert.equal(
    listEconomicsSamples(handle).length,
    0,
    'no carry-forward, no interpolation, no zero — the epoch is simply absent'
  );
  handle.close();
});

test('a price outage costs the price, not the on-chain row', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);

  await sampleEconomics(handle, async () => inputs(1_000), {
    now: NOW,
    fetchPrice: async () => null,
  });

  const [row] = listEconomicsSamples(handle);
  assert.equal(row.protocolBalance, 1_000, 'the on-chain sample is still written');
  assert.equal(row.arioPriceUsd, null);
  assert.equal(row.arioPriceSource, null);
  handle.close();
});

test('the row records when the balance was observed, not when the job ran', async () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR);
  const observedAt = NOW - 7 * 60 * 1000;

  await sampleEconomics(
    handle,
    async () => ({ ...inputs(1_000), observedAt }),
    { now: NOW, fetchPrice: noPrice }
  );

  assert.equal(listEconomicsSamples(handle)[0].sampledAt, observedAt);
  handle.close();
});

test('the document publishes components and no derived conclusion', () => {
  const handle = db();
  addEpoch(handle, 523, 2 * HOUR, 1, 66_817_270_548);

  const doc = buildEconomicsDocument(
    [
      {
        epochIndex: 523,
        sampledAt: NOW,
        slot: null,
        protocolBalance: 118_314_891_603_471,
        totalEligibleRewards: 66_817_270_548,
        demandFactor: 7.226342,
        circulating: 1,
        staked: 2,
        delegated: 3,
        arnsRecordCount: 4,
        arioPriceUsd: 0.00073145,
        arioPriceSource: 'coingecko:ar-io-network',
        arioPriceAt: NOW,
      },
    ],
    () => Math.floor(NOW / 1000),
    new Date(NOW).toISOString()
  );

  const [row] = doc.series;
  assert.equal(row.protocolBalance, 118_314_891_603_471);
  assert.equal(row.totalEligibleRewards, 66_817_270_548);

  // The balance moves for reasons that are not ArNS revenue, so publishing a
  // field called `revenue` would assert an attribution nothing here can back.
  for (const forbidden of ['revenue', 'netInflow', 'protocolBalanceUsd']) {
    assert.equal(
      forbidden in row,
      false,
      `${forbidden} must not be published — components only, the consumer subtracts`
    );
  }

  // Seconds in the store, milliseconds on the wire. Publishing it raw puts
  // every timestamp in 1970 for anyone calling `new Date(value)`.
  assert.equal(row.endTimestamp, Math.floor(NOW / 1000) * 1000);
});

test('an empty series is a valid document, not an error', () => {
  const doc = buildEconomicsDocument([], () => null, new Date(NOW).toISOString());
  assert.deepEqual(doc.series, []);
  assert.equal(doc.schemaVersion, '1.0');
});
