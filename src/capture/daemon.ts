#!/usr/bin/env node

/**
 * ENTRY POINT (a) — the capture daemon.
 *
 * One job: never miss an epoch. Observation accounts are swept off the chain
 * by permissionless `close_observation` within days, so anything not captured
 * while it is live is lost permanently.
 *
 * A cycle is one `getProgramAccounts`, a decode pass, and one transaction.
 * No HTTP serving, no DNS, no geo, no analysis; it never touches `public/`.
 * Resist adding features here.
 */

import type { Database } from 'better-sqlite3';
import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { openWriter, tryOpenReader, resolveDbPath } from '../db/index.js';
import {
  finishPollRun,
  insertRawUnparsed,
  insertRegistrySlots,
  startPollRun,
  upsertObservations,
  type PollRunOutcome,
} from '../db/repo-write.js';
import { consecutiveFailedPollRuns, latestPollRun } from '../db/repo-read.js';
import { acquireCaptureLock, type CaptureLock } from './lock.js';
import {
  assertDiscriminatorMatchesSdk,
  decodeObservationAccount,
  loadSdkDecoder,
} from './decode.js';
import { createRpcClient, fetchDiscriminatorOnlyCount, fetchObservationAccounts } from './rpc.js';
import { fetchRegistrySlotOrder } from './registry.js';
import type { DecodedObservation, RegistrySnapshot } from '../observers/types.js';

const DEFAULT_POLL_INTERVAL_MS = 600_000; // 10 minutes
const CANARY_INTERVAL_MS = 3_600_000; // 1 hour
const ZERO_ACCOUNT_WARN_CYCLES = 6; // 1 hour of empty reads

interface DaemonState {
  lastContextSlot: number;
  consecutiveZeroCycles: number;
  consecutiveFailures: number;
  lastCanaryAt: number;
  lastSchemaMajor: number | null;
  stopping: boolean;
}

function pollIntervalMs(): number {
  const raw = parseInt(process.env.OBSERVER_POLL_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_INTERVAL_MS;
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Epochs we have observations for but no registry slot order yet. */
function epochsMissingRegistry(db: Database, epochIndexes: number[]): number[] {
  const missing: number[] = [];
  const check = db.prepare<[number], { n: number }>(
    'SELECT COUNT(*) AS n FROM registry_snapshots WHERE epoch_index = ?'
  );
  for (const epochIndex of epochIndexes) {
    const row = check.get(epochIndex);
    if (!row || row.n === 0) missing.push(epochIndex);
  }
  return missing;
}

/**
 * One capture cycle. Catches everything: a cycle must never kill the process.
 * Worst case is a single lost 10-minute sample against a multi-day window.
 */
async function runCycle(
  db: Database,
  client: Awaited<ReturnType<typeof createRpcClient>>,
  state: DaemonState
): Promise<void> {
  const startedAt = Date.now();
  const runId = startPollRun(db, startedAt);

  try {
    const { contextSlot, accounts } = await fetchObservationAccounts(client);

    const isStale = state.lastContextSlot > 0 && contextSlot < state.lastContextSlot;
    if (isStale) {
      log(
        'warn',
        `⚠️  stale replica: context slot ${contextSlot} < previous ${state.lastContextSlot}; ` +
          `absences from this read mean nothing`
      );
    }

    const decoded: DecodedObservation[] = [];
    const unparsed: Array<{ pubkey: string; data: Buffer; reason: string }> = [];

    for (const account of accounts) {
      const outcome = decodeObservationAccount(account);
      if (outcome.ok) decoded.push(outcome.record);
      else unparsed.push({ pubkey: account.pubkey, data: account.data, reason: outcome.reason });
    }

    for (const failure of unparsed) {
      log('warn', `⚠️  decode failed for ${failure.pubkey}: ${failure.reason} (bytes parked)`);
    }

    // Schema-version drift is loud but never fatal: storing possibly
    // mis-decoded data with a version marker beats storing nothing.
    for (const record of decoded) {
      const major = record.schemaVersion?.major ?? null;
      if (major === null) continue;
      if (state.lastSchemaMajor !== null && major !== state.lastSchemaMajor) {
        log(
          'error',
          `❌ observation schema major changed ${state.lastSchemaMajor} -> ${major} ` +
            `(observer ${record.observer}, epoch ${record.epochIndex}); capture continues`
        );
      }
      state.lastSchemaMajor = major;
    }

    // Hourly layout canary: discriminator-only count vs the size-filtered count.
    let canaryCount: number | null = null;
    let layoutDrift = false;
    if (startedAt - state.lastCanaryAt >= CANARY_INTERVAL_MS) {
      canaryCount = await fetchDiscriminatorOnlyCount(client);
      state.lastCanaryAt = startedAt;
      if (canaryCount > accounts.length) {
        layoutDrift = true;
        log(
          'error',
          `❌ LAYOUT_DRIFT: discriminator-only count ${canaryCount} > sized count ${accounts.length}. ` +
            `The Observation account size changed; the primary query is missing rows.`
        );
      }
    }

    // Registry slot order for any epoch we have not snapshotted yet. A failure
    // here must not cost us the observations, so it is fetched before the
    // transaction and simply retried next cycle if it fails.
    const epochIndexes = [...new Set(decoded.map((r) => r.epochIndex))];
    const registrySnapshots: RegistrySnapshot[] = [];
    for (const epochIndex of epochsMissingRegistry(db, epochIndexes)) {
      try {
        registrySnapshots.push(await fetchRegistrySlotOrder(client, epochIndex));
        log('info', `📐 captured registry slot order for epoch ${epochIndex}`);
      } catch (error) {
        log(
          'warn',
          `⚠️  registry snapshot for epoch ${epochIndex} failed: ${scrubSecrets(error)} (retry next cycle)`
        );
      }
    }

    const finishedAt = Date.now();
    let result = { inserted: 0, updated: 0, revisions: 0 };

    // Everything the cycle learned lands atomically with the poll_runs row,
    // so "cycle N completed" can never be true without cycle N's data.
    const commit = db.transaction(() => {
      result = upsertObservations(db, decoded, finishedAt, contextSlot);
      for (const failure of unparsed) {
        insertRawUnparsed(
          db,
          failure.pubkey,
          failure.data,
          failure.reason,
          finishedAt,
          contextSlot
        );
      }
      for (const snapshot of registrySnapshots) insertRegistrySlots(db, snapshot);

      const outcome: PollRunOutcome = {
        contextSlot,
        accountCount: accounts.length,
        inserted: result.inserted,
        updated: result.updated,
        revisions: result.revisions,
        unparsed: unparsed.length,
        canaryCount,
        status: isStale ? 'stale' : 'ok',
        error: layoutDrift ? 'LAYOUT_DRIFT' : null,
      };
      finishPollRun(db, runId, startedAt, finishedAt, outcome);
    });
    commit.immediate();

    state.consecutiveFailures = 0;
    if (!isStale) state.lastContextSlot = contextSlot;

    if (accounts.length === 0) {
      state.consecutiveZeroCycles++;
      if (state.consecutiveZeroCycles >= ZERO_ACCOUNT_WARN_CYCLES) {
        log(
          'warn',
          `⚠️  ${state.consecutiveZeroCycles} consecutive cycles with zero observation accounts ` +
            `(close_observation is permissionless, so this can be legitimate)`
        );
      }
    } else {
      state.consecutiveZeroCycles = 0;
    }

    log(
      'info',
      `✅ slot ${contextSlot} · ${accounts.length} accounts · +${result.inserted} new · ` +
        `${result.updated} seen · ${result.revisions} revised · ${unparsed.length} unparsed · ` +
        `${finishedAt - startedAt}ms`
    );
  } catch (error) {
    state.consecutiveFailures++;
    const scrubbed = scrubSecrets(error);
    const sustained = state.consecutiveFailures >= 3;
    const finishedAt = Date.now();

    finishPollRun(db, runId, startedAt, finishedAt, {
      contextSlot: null,
      accountCount: null,
      inserted: null,
      updated: null,
      revisions: null,
      unparsed: null,
      canaryCount: null,
      status: 'failed',
      error: sustained ? `SUSTAINED: ${scrubbed}` : scrubbed,
    });

    log(
      sustained ? 'error' : 'warn',
      `${sustained ? '❌ SUSTAINED' : '⚠️'} capture cycle failed ` +
        `(${state.consecutiveFailures} consecutive): ${scrubbed}`
    );
  }
}

/** `--status`: read-only summary of the most recent runs. */
function printStatus(): void {
  const db = tryOpenReader();
  if (!db) {
    console.log(`No capture database at ${resolveDbPath()} (capture has never run).`);
    return;
  }

  const latest = latestPollRun(db);
  const failures = consecutiveFailedPollRuns(db);
  const counts = db
    .prepare<[], { observations: number; epochs: number; unparsed: number; revisions: number }>(
      `SELECT (SELECT COUNT(*) FROM observations)                AS observations,
              (SELECT COUNT(DISTINCT epoch_index) FROM observations) AS epochs,
              (SELECT COUNT(*) FROM raw_unparsed)                AS unparsed,
              (SELECT COUNT(*) FROM observation_revisions)       AS revisions`
    )
    .get();

  console.log(`Database:        ${resolveDbPath()}`);
  console.log(`Observations:    ${counts?.observations ?? 0} across ${counts?.epochs ?? 0} epochs`);
  console.log(`Revisions:       ${counts?.revisions ?? 0}`);
  console.log(`Unparsed:        ${counts?.unparsed ?? 0}`);
  if (latest) {
    const ageSeconds = Math.round((Date.now() - latest.startedAt) / 1000);
    console.log(
      `Last run:        ${new Date(latest.startedAt).toISOString()} (${ageSeconds}s ago)`
    );
    console.log(`Last status:     ${latest.status}`);
    console.log(`Last slot:       ${latest.contextSlot ?? 'n/a'}`);
    console.log(`Accounts seen:   ${latest.accountCount ?? 'n/a'}`);
    if (latest.error) console.log(`Last error:      ${latest.error}`);
  } else {
    console.log('Last run:        never');
  }
  console.log(`Consecutive failures: ${failures}`);
  db.close();
}

async function main(): Promise<void> {
  assertNodeVersion();

  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    printStatus();
    return;
  }

  const once = args.includes('--once');
  const interval = pollIntervalMs();

  // A wrong discriminator returns zero accounts, which looks exactly like a
  // quiet network. Refuse to start rather than capture silence.
  await assertDiscriminatorMatchesSdk();
  await loadSdkDecoder();

  // If the database cannot be opened, exit non-zero: a capture daemon that
  // cannot persist is worse than a dead one — the supervisor will restart it
  // and the failure is visible.
  const db = openWriter();
  let lock: CaptureLock;
  try {
    lock = acquireCaptureLock(db, interval);
  } catch (error) {
    log('error', `❌ ${(error as Error).message}`);
    db.close();
    process.exit(1);
  }

  const client = await createRpcClient();
  log('info', `📡 capture starting · rpc host ${client.host} · db ${resolveDbPath()}`);
  if (!once) log('info', `⏱️  interval ${Math.round(interval / 1000)}s`);

  const state: DaemonState = {
    lastContextSlot: 0,
    consecutiveZeroCycles: 0,
    consecutiveFailures: 0,
    lastCanaryAt: 0,
    lastSchemaMajor: null,
    stopping: false,
  };

  let timer: NodeJS.Timeout | null = null;
  let cycleInFlight = false;

  const finish = (): void => {
    try {
      lock.release();
    } finally {
      db.close();
    }
  };

  /**
   * Signals stop the schedule. A cycle already in flight is allowed to reach
   * its COMMIT — it is a single transaction, and interrupting it would throw
   * away that sample for nothing.
   */
  const shutdown = (signal: string) => {
    if (state.stopping) return;
    state.stopping = true;
    if (timer) clearTimeout(timer);
    log(
      'info',
      `👋 ${signal} received, ${cycleInFlight ? 'finishing the current cycle then exiting' : 'exiting'}`
    );
    if (!cycleInFlight) {
      finish();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Self-scheduling: the next cycle is armed only after this one completes,
  // so ticks can never overlap.
  const loop = async (): Promise<void> => {
    const started = Date.now();
    cycleInFlight = true;
    await runCycle(db, client, state);
    cycleInFlight = false;
    lock.heartbeat();

    if (state.stopping) {
      finish();
      process.exit(0);
    }
    if (once) return;

    const delay = Math.max(0, interval - (Date.now() - started));
    timer = setTimeout(() => {
      void loop();
    }, delay);
  };

  await loop();

  if (once) finish();
}

main().catch((error) => {
  console.error(`❌ capture failed to start: ${scrubSecrets(error)}`);
  process.exit(1);
});
