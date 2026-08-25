/**
 * The backfill writes history, which is the one thing the live sampler refuses
 * to do — so it carries the burden of proving each row is a measurement rather
 * than an inference. Every test here targets a way a plausible-but-wrong series
 * could be produced silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import { listEconomicsSamples } from '../src/db/repo-read.js';
import {
  backfillEconomics,
  priceCloseDateForEpochEnd,
  type BackfillDeps,
  type SignatureRef,
} from '../src/economics/backfill.js';
import { parsePriceHistory, loadPriceHistory, priceForCloseDate } from '../src/economics/price-history.js';

function db() {
  const handle = new BetterSqlite3(':memory:');
  applyMigrations(handle);
  return handle;
}

/** Epochs end just after midnight UTC, as they do on chain. */
function addEpoch(
  handle: BetterSqlite3.Database,
  epochIndex: number,
  endIso: string,
  eligible: number | null = 1_000
) {
  const seconds = Math.floor(Date.parse(endIso) / 1000);
  handle
    .prepare(
      `INSERT INTO epochs (epoch_index, end_timestamp, rewards_distributed,
                           total_eligible_rewards, account_bytes,
                           first_seen_at, last_seen_at)
       VALUES (?, ?, 1, ?, 0, ?, ?)`
    )
    .run(epochIndex, seconds, eligible, seconds * 1000, seconds * 1000);
}

const sig = (
  signature: string,
  blockTime: string,
  slot: number,
  err: unknown = null
): SignatureRef => ({ signature, blockTime: Math.floor(Date.parse(blockTime) / 1000), slot, err });

function deps(
  signatures: SignatureRef[],
  balances: Record<string, number | null>,
  prices: Record<string, number> = {}
): BackfillDeps {
  return {
    listSignatures: async () => signatures,
    balanceAfter: async (signature) => balances[signature] ?? null,
    priceForCloseDate: (closeDate) => prices[closeDate] ?? null,
    priceSource: 'test',
  };
}

test('an epoch takes the close price of the day BEFORE it ended', () => {
  // The whole series hinges on this. CoinGecko's /history?date=D reports the
  // 00:00 snapshot of D, which is the close of D-1; an epoch ending 00:04 on
  // the 25th is therefore priced at the 24th's close. One row of drift here was
  // worth 23% on 2026-08-18.
  assert.equal(priceCloseDateForEpochEnd(Date.parse('2026-08-25T00:04:00Z')), '2026-08-24');

  // Not a midnight special case: any moment on D takes D-1's close, because
  // D's own close has not happened yet.
  assert.equal(priceCloseDateForEpochEnd(Date.parse('2026-08-25T23:59:00Z')), '2026-08-24');
  assert.equal(priceCloseDateForEpochEnd(Date.parse('2026-08-25T00:00:00Z')), '2026-08-24');
});

test('the balance comes from the last transaction that actually changed it', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  await backfillEconomics(
    handle,
    deps(
      [
        sig('a', '2026-08-21T10:00:00Z', 100),
        // Later, but carried no balance entry for this account — walking back
        // past it is exact, not a fallback: nothing changed the balance since.
        sig('b', '2026-08-21T23:00:00Z', 200),
      ],
      { a: 5_000, b: null }
    )
  );

  const [row] = listEconomicsSamples(handle);
  assert.equal(row.protocolBalance, 5_000);
  assert.equal(row.slot, 100, 'the slot must be the one the balance was read at');
  handle.close();
});

test('failed transactions are never read as balances', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  await backfillEconomics(
    handle,
    deps(
      [
        sig('good', '2026-08-21T10:00:00Z', 100),
        // 9.2% of this account's real history. A failed tx changed nothing, so
        // treating it as the latest state would report a stale balance as current.
        sig('failed', '2026-08-21T23:00:00Z', 200, { InstructionError: [0, 'Custom'] }),
      ],
      { good: 5_000, failed: 999_999 }
    )
  );

  assert.equal(listEconomicsSamples(handle)[0].protocolBalance, 5_000);
  handle.close();
});

test('transactions after the epoch boundary cannot leak backwards', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  await backfillEconomics(
    handle,
    deps(
      [
        sig('before', '2026-08-21T10:00:00Z', 100),
        sig('after', '2026-08-23T10:00:00Z', 300),
      ],
      { before: 5_000, after: 7_000 }
    )
  );

  assert.equal(
    listEconomicsSamples(handle)[0].protocolBalance,
    5_000,
    "using today's balance for an old epoch is the fabrication this exists to avoid"
  );
  handle.close();
});

test('an epoch with no recoverable balance is a gap, not a row', async () => {
  const handle = db();
  addEpoch(handle, 507, '2026-06-04T00:04:00Z'); // before any known signature
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  const result = await backfillEconomics(
    handle,
    deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 })
  );

  assert.deepEqual(result.unrecoverable, [507]);
  assert.deepEqual(result.recovered, [520]);
  assert.deepEqual(
    listEconomicsSamples(handle).map((r) => r.epochIndex),
    [520],
    'the unrecoverable epoch is absent — not zero, not carried forward'
  );
  handle.close();
});

test('backfilled rows leave unrecoverable fields null rather than borrowing today\'s', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z', 66_817);

  await backfillEconomics(
    handle,
    deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 }, { '2026-08-21': 0.000518 })
  );

  const [row] = listEconomicsSamples(handle);
  // Recoverable from the chain's own record:
  assert.equal(row.protocolBalance, 5_000);
  assert.equal(row.totalEligibleRewards, 66_817);
  assert.equal(row.arioPriceUsd, 0.000518);
  // NOT recoverable — historical PDA state is not in transaction metadata, so
  // filling these from the present would look like data and be fiction.
  for (const field of ['demandFactor', 'circulating', 'staked', 'delegated', 'arnsRecordCount'] as const) {
    assert.equal(row[field], null, `${field} must stay null on a backfilled row`);
  }
  handle.close();
});

test('the row is stamped with the epoch boundary, not when the recovery ran', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  await backfillEconomics(
    handle,
    deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 })
  );

  assert.equal(listEconomicsSamples(handle)[0].sampledAt, Date.parse('2026-08-22T00:04:00Z'));
  handle.close();
});

test('re-running never revises an existing sample', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');
  const first = deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 });
  await backfillEconomics(handle, first);

  const second = await backfillEconomics(
    handle,
    deps([sig('b', '2026-08-21T20:00:00Z', 150)], { b: 9_999 })
  );

  assert.deepEqual(second.recovered, [], 'an already-sampled epoch is not revisited');
  assert.equal(listEconomicsSamples(handle)[0].protocolBalance, 5_000);
  handle.close();
});

test('a dry run reports rows without writing any', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');

  const result = await backfillEconomics(
    handle,
    deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 }),
    { dryRun: true }
  );

  assert.deepEqual(result.recovered, [520]);
  assert.equal(result.rows[0].protocolBalance, 5_000);
  assert.equal(listEconomicsSamples(handle).length, 0, 'a dry run must not write');
  handle.close();
});

test('the checked-in price history parses and covers the migration period', () => {
  const handle = db();
  const { loaded } = loadPriceHistory(handle);

  assert.ok(loaded >= 78, `expected the full exported history, got ${loaded}`);
  assert.equal(priceForCloseDate(handle, '2026-08-24'), 0.00078441);
  assert.equal(
    priceForCloseDate(handle, '2026-08-25'),
    null,
    'the 25th had not closed — it must be absent rather than approximated'
  );
  // Re-loading is a no-op; a historical close does not change.
  assert.equal(loadPriceHistory(handle).loaded, 0);
  handle.close();
});

test('a malformed price row fails loudly instead of becoming a null price', () => {
  assert.throws(() => parsePriceHistory('close_date,price_usd\n2026-08-24,notanumber\n'), /bad price/);
  assert.throws(() => parsePriceHistory('close_date,price_usd\n24-08-2026,0.0007\n'), /bad date/);
  assert.throws(() => parsePriceHistory('close_date,price_usd\n2026-08-24,0\n'), /bad price/);
  assert.deepEqual(parsePriceHistory('# comment\nclose_date,price_usd\n2026-08-24,0.0007\n'), [
    { closeDate: '2026-08-24', priceUsd: 0.0007 },
  ]);
});

test('re-anchoring is opt-in, and replaces only drift-anchored rows', async () => {
  const handle = db();
  addEpoch(handle, 520, '2026-08-22T00:04:00Z');
  const boundaryMs = Date.parse('2026-08-22T00:04:00Z');

  // A row as the old sampler wrote it: 15.4 hours past the boundary, so its
  // balance includes activity belonging to the following epoch.
  handle
    .prepare(
      `INSERT INTO economics_samples (epoch_index, sampled_at, protocol_balance)
       VALUES (520, ?, 9999)`
    )
    .run(boundaryMs + 15.4 * 3600 * 1000);

  const d = deps([sig('a', '2026-08-21T10:00:00Z', 100)], { a: 5_000 });

  const untouched = await backfillEconomics(handle, d);
  assert.deepEqual(untouched.reanchored, [], 'a plain run must never overwrite an existing row');
  assert.equal(listEconomicsSamples(handle)[0].protocolBalance, 9999);

  const fixed = await backfillEconomics(handle, d, { reanchor: true });
  assert.deepEqual(fixed.reanchored, [520]);
  const [row] = listEconomicsSamples(handle);
  assert.equal(row.protocolBalance, 5_000, 'the boundary balance replaces the drifted one');
  assert.equal(row.sampledAt, boundaryMs);

  // Already correct now, so a second re-anchor finds nothing to do.
  const again = await backfillEconomics(handle, d, { reanchor: true });
  assert.deepEqual(again.reanchored, []);
  handle.close();
});
