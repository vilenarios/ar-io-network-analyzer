#!/usr/bin/env node

/**
 * ENTRY POINT — one-shot historical recovery for the economics series.
 *
 * Deliberately NOT wired into any timer. The hourly job must never be able to
 * write history; this exists so that writing history is always something a
 * person chose to do, with the flags below as the record of that choice.
 *
 *   yarn economics:backfill                 # dry run: report, write nothing
 *   yarn economics:backfill --apply
 *   yarn economics:backfill --apply --reanchor
 *
 * `--reanchor` additionally REPLACES existing rows whose `sampled_at` is not
 * the epoch boundary — rows written under the old "sample whenever the job ran"
 * behaviour, which are not comparable to their neighbours. It is opt-in because
 * it is the only thing here that overwrites a row that already exists.
 *
 * Reads `SOLANA_RPC_URL`. Safe to re-run: every write is INSERT OR IGNORE on
 * the epoch, so an interrupted run resumes and a completed one is a no-op.
 */

import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { openWriter } from '../db/index.js';
import { listEconomicsSamples } from '../db/repo-read.js';
import { readEconomicsInputsFromSummary } from './inputs.js';
import { publicDir } from '../publish/publish.js';
import { backfillEconomics } from './backfill.js';
import {
  PROTOCOL_TOKEN_ACCOUNT,
  assertMatchesLiveBalance,
  createBalanceReader,
} from './solana-balance.js';
import {
  PRICE_HISTORY_SOURCE,
  loadPriceHistory,
  priceForCloseDate,
} from './price-history.js';

async function main(): Promise<void> {
  assertNodeVersion();
  const apply = process.argv.includes('--apply');
  const reanchor = process.argv.includes('--reanchor');
  const dryRun = !apply;
  const db = openWriter();
  const reader = createBalanceReader();

  console.log('economics backfill');
  console.log(`  mode: ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}${reanchor ? ' +reanchor' : ''}`);

  const priceLoad = loadPriceHistory(db, { dryRun });
  console.log(
    `  prices: ${priceLoad.loaded} ${dryRun ? 'would load' : 'loaded'}, ` +
      `${priceLoad.alreadyPresent} already present ` +
      `(${PRICE_HISTORY_SOURCE})`
  );

  const parsedPrices = new Map(priceLoad.prices.map((p) => [p.closeDate, p.priceUsd]));

  // Never trust the hardcoded address: a wrong one yields a complete,
  // plausible, entirely fictional series rather than an error.
  const live = readEconomicsInputsFromSummary(publicDir());
  if (!live) {
    throw new Error(
      'cannot verify the token account: portal/summary.json is missing or stale. ' +
        'Refusing to write history from an unverified address.'
    );
  }
  const verified = await assertMatchesLiveBalance(reader, live.protocolBalance);
  console.log(`  verified ${PROTOCOL_TOKEN_ACCOUNT} == live protocolBalance (${verified} mARIO)`);

  const before = listEconomicsSamples(db).length;
  const result = await backfillEconomics(
    db,
    {
      listSignatures: () => reader.listSignatures(),
      balanceAfter: (signature) => reader.balanceAfter(signature),
      // Falls back to the parsed file, because a dry run suppresses the price
      // inserts too — without this the report would claim every row lacks a
      // price, which is precisely the misleading output a dry run exists to
      // rule out.
      priceForCloseDate: (closeDate) =>
        priceForCloseDate(db, closeDate) ?? parsedPrices.get(closeDate) ?? null,
      priceSource: PRICE_HISTORY_SOURCE,
    },
    { dryRun, reanchor }
  );

  console.log(`  transactions read: ${result.transactionsRead}, rpc calls: ${reader.rpcCalls()}`);
  console.log(`  epochs recovered:  ${result.recovered.length}`);
  if (result.reanchored.length > 0) {
    console.log(
      `  epochs re-anchored: ${JSON.stringify(result.reanchored)} — existing rows REPLACED ` +
        `with the balance at the epoch boundary`
    );
  } else if (!reanchor) {
    console.log('  (pass --reanchor to also correct rows not anchored to their boundary)');
  }
  for (const row of result.rows) {
    const price = row.arioPriceUsd === null ? 'no price' : `$${row.arioPriceUsd.toFixed(8)}`;
    console.log(
      `    epoch ${row.epochIndex}  ${row.protocolBalance} mARIO  slot ${row.slot ?? 'n/a'}  ` +
        `${price} (close ${row.priceCloseDate})`
    );
  }
  if (result.unrecoverable.length > 0) {
    // Named explicitly rather than counted: these are gaps in a published
    // series, and a silent count is how a gap gets mistaken for a zero.
    console.log(
      `  epochs unrecoverable: ${JSON.stringify(result.unrecoverable)} — left absent, not zeroed`
    );
  }
  console.log(`  series: ${before} -> ${dryRun ? before + result.recovered.length : listEconomicsSamples(db).length} rows`);

  if (dryRun) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to keep this.');
  }
  db.close();
}

main().catch((error) => {
  console.error(scrubSecrets(String(error instanceof Error ? error.stack : error)));
  process.exit(1);
});
