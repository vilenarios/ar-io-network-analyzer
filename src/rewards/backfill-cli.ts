#!/usr/bin/env node

/**
 * ENTRY POINT — recover delegate reward history from chain.
 *
 *   yarn rewards:backfill            # dry run: report, write nothing
 *   yarn rewards:backfill --apply
 *
 * Safe to re-run and safe to interrupt: reward events are immutable log data,
 * so a rescan recomputes identical totals. This is the opposite of
 * `stake_samples`, which is an observation that cannot be recovered if missed.
 *
 * Covers DELEGATES only. `DistributeEpoch` emits no per-operator record — just
 * an epoch summary — so operator earnings come from stake snapshots instead.
 */

import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { openWriter } from '../db/index.js';
import { createProgramReader } from './program-reader.js';
import { epochsAwaitingRewardScan, scanDelegateRewards } from './scan.js';

async function main(): Promise<void> {
  assertNodeVersion();
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  const db = openWriter();
  const reader = createProgramReader();

  console.log('delegate reward backfill');
  console.log(`  mode: ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`);

  const pending = epochsAwaitingRewardScan(db);
  if (pending.length === 0) {
    console.log('  nothing to scan — every distributed epoch has been scanned.');
    db.close();
    return;
  }
  console.log(`  epochs to scan: ${pending.length} (${pending[0]}..${pending[pending.length - 1]})`);

  if (dryRun) {
    // A dry run must not write, and scanning writes by design, so it reports
    // the plan rather than pretending to produce totals it cannot keep.
    console.log('\nDRY RUN — no scan performed. Re-run with --apply to scan and write.');
    db.close();
    return;
  }

  const result = await scanDelegateRewards(db, reader, pending);

  console.log(`  transactions read: ${result.transactions}`);
  console.log(`  reward events:     ${result.events}`);
  console.log(`  total credited:    ${(result.totalAmount / 1e6).toFixed(6)} ARIO`);
  console.log(`  rpc calls:         ${reader.rpcCalls()}`);

  const perEpoch = db
    .prepare(
      `SELECT r.epoch_index AS epochIndex, COUNT(*) AS delegations, SUM(r.amount) AS total
         FROM delegate_rewards r GROUP BY r.epoch_index ORDER BY r.epoch_index`
    )
    .all() as { epochIndex: number; delegations: number; total: number }[];

  console.log('\n  epoch   delegations        rewarded');
  for (const row of perEpoch) {
    console.log(
      `  ${String(row.epochIndex).padStart(5)}   ${String(row.delegations).padStart(11)}   ` +
        `${(row.total / 1e6).toFixed(6).padStart(13)} ARIO`
    );
  }

  const empty = db
    .prepare('SELECT epoch_index FROM delegate_reward_scans WHERE events = 0 ORDER BY epoch_index')
    .all() as { epoch_index: number }[];
  if (empty.length > 0) {
    // Scanned and genuinely empty — recorded so it is never mistaken for
    // "not looked at", which would read as "earned nothing".
    console.log(`\n  scanned with no events: ${empty.map((e) => e.epoch_index).join(', ')}`);
  }

  db.close();
}

main().catch((error) => {
  console.error(scrubSecrets(String(error instanceof Error ? error.stack : error)));
  process.exit(1);
});
