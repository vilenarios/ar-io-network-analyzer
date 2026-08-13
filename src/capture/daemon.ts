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
 *
 * Two invariants follow from "never miss an epoch", and both are load-bearing:
 *  - Nothing a cycle does may kill the process. Every database write on the
 *    cycle path — including the ones in the failure path — is wrapped, because
 *    an abnormal exit also leaves a capture lock behind (see lock.ts).
 *  - A cycle that captured nothing is never reported as success. See status.ts.
 */

import type { Database } from 'better-sqlite3';
import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { openWriter, tryOpenReader, resolveDbPath } from '../db/index.js';
import {
  finishPollRun,
  insertRawUnparsed,
  insertRegistrySlots,
  prunePollRuns,
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
import { classifyCycle, type CycleClassification } from './status.js';
import type { DecodedObservation, RegistrySnapshot } from '../observers/types.js';

const DEFAULT_POLL_INTERVAL_MS = 600_000; // 10 minutes
const CANARY_INTERVAL_MS = 3_600_000; // 1 hour
const ZERO_ACCOUNT_WARN_CYCLES = 6; // 1 hour of empty reads
const DEFAULT_POLL_RUN_RETENTION_DAYS = 30;

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

function pollRunRetentionMs(): number {
  const raw = parseInt(process.env.POLL_RUN_RETENTION_DAYS || '', 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_RUN_RETENTION_DAYS;
  return days * 86_400_000;
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Run a database write that sits OUTSIDE the cycle's own try/catch.
 *
 * `SQLITE_BUSY` (another writer held the file past the busy timeout) or
 * `SQLITE_FULL` here used to reject out of `runCycle` and, because the loop is
 * armed with `void loop()`, terminate the process as an unhandled rejection —
 * turning transient contention into a dead daemon plus a lock nobody could
 * take for half an hour. Bookkeeping is worth strictly less than staying up.
 */
function safeWrite<T>(what: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    log('error', `❌ database write failed (${what}): ${scrubSecrets(error)}; capture continues`);
    return null;
  }
}

/**
 * Which epochs still need a registry slot-order snapshot.
 *
 * Two cases: an epoch with no snapshot at all, and the LIVE epoch whose only
 * snapshot is approximate (taken by an older build, or by a cycle that first
 * saw the epoch after it closed). The live epoch is the only one that can ever
 * be upgraded — once it closes, the order it had is gone for good — so it is
 * worth one extra `getAccountInfo` to get it right while we still can.
 */
export function epochsNeedingRegistry(
  db: Database,
  epochIndexes: number[],
  liveEpochIndex: number | null
): number[] {
  const needed: number[] = [];
  const check = db.prepare<[number], { n: number; in_epoch: number | null }>(
    `SELECT COUNT(*) AS n, MAX(in_epoch) AS in_epoch
       FROM registry_snapshots WHERE epoch_index = ?`
  );

  for (const epochIndex of epochIndexes) {
    const row = check.get(epochIndex);
    if (!row || row.n === 0) {
      needed.push(epochIndex);
    } else if (epochIndex === liveEpochIndex && row.in_epoch !== 1) {
      needed.push(epochIndex);
    }
  }
  return needed;
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
  const runId = safeWrite('startPollRun', () => startPollRun(db, startedAt));

  try {
    const { contextSlot, accounts } = await fetchObservationAccounts(client);

    const isStale = state.lastContextSlot > 0 && contextSlot < state.lastContextSlot;
    if (isStale) {
      log(
        'warn',
        `⚠️  stale replica: context slot ${contextSlot} < previous ${state.lastContextSlot}; ` +
          `absences from this read mean nothing and older rows will be refused`
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
    //
    // `getAccountInfo` on the registry PDA always returns the CURRENT slot
    // order — the epoch index only labels it. A snapshot taken while its epoch
    // is still live is authoritative; one taken for an epoch that has already
    // closed is an approximation (any gateway that joined or left since shifts
    // every slot after it) and is stored with `inEpoch: false`, so nothing
    // downstream can mistake it for a decodable slot order.
    const epochIndexes = [...new Set(decoded.map((r) => r.epochIndex))];
    const liveEpochIndex = epochIndexes.length > 0 ? Math.max(...epochIndexes) : null;
    const registrySnapshots: RegistrySnapshot[] = [];
    for (const epochIndex of epochsNeedingRegistry(db, epochIndexes, liveEpochIndex)) {
      try {
        const snapshot = await fetchRegistrySlotOrder(client, epochIndex);
        snapshot.inEpoch = epochIndex === liveEpochIndex;
        registrySnapshots.push(snapshot);
        log(
          'info',
          `📐 captured registry slot order for epoch ${epochIndex}` +
            (snapshot.inEpoch ? '' : ' (APPROXIMATE — the epoch had already closed)')
        );
      } catch (error) {
        log(
          'warn',
          `⚠️  registry snapshot for epoch ${epochIndex} failed: ${scrubSecrets(error)} (retry next cycle)`
        );
      }
    }

    const finishedAt = Date.now();
    let result = { inserted: 0, updated: 0, revisions: 0, stale: 0, duplicateKeys: 0 };
    let repeatedUnparsed = 0;

    // Everything the cycle learned lands atomically with the poll_runs row,
    // so "cycle N completed" can never be true without cycle N's data.
    const commit = db.transaction((): CycleClassification => {
      result = upsertObservations(db, decoded, finishedAt, contextSlot);
      repeatedUnparsed = 0;
      for (const failure of unparsed) {
        const outcome = insertRawUnparsed(
          db,
          failure.pubkey,
          failure.data,
          failure.reason,
          finishedAt,
          contextSlot
        );
        if (outcome === 'repeated') repeatedUnparsed++;
      }
      for (const snapshot of registrySnapshots) insertRegistrySlots(db, snapshot);

      const classified = classifyCycle({
        accountCount: accounts.length,
        decodedCount: decoded.length,
        isStale,
        layoutDrift,
        duplicateKeys: result.duplicateKeys,
      });

      const outcome: PollRunOutcome = {
        contextSlot,
        accountCount: accounts.length,
        inserted: result.inserted,
        updated: result.updated,
        revisions: result.revisions,
        unparsed: unparsed.length,
        canaryCount,
        status: classified.status,
        error: classified.anomaly,
      };
      if (runId !== null) finishPollRun(db, runId, startedAt, finishedAt, outcome);
      return classified;
    });

    const classification: CycleClassification = safeWrite('cycle commit', () =>
      commit.immediate()
    ) ?? { status: 'failed', anomaly: null };

    state.consecutiveFailures = classification.status === 'failed' ? 1 : 0;
    if (!isStale) state.lastContextSlot = contextSlot;

    if (result.duplicateKeys > 0) {
      log(
        'error',
        `❌ DUPLICATE_OBSERVER_KEYS: ${result.duplicateKeys} (epoch, observer) key(s) appeared ` +
          `twice in one read — two live accounts claim one identity and only the last one in ` +
          `the response survives`
      );
    }
    if (result.stale > 0) {
      log(
        'warn',
        `⚠️  refused ${result.stale} older observation(s): this read is behind what is stored`
      );
    }

    if (accounts.length === 0) {
      state.consecutiveZeroCycles++;
      log(
        state.consecutiveZeroCycles >= ZERO_ACCOUNT_WARN_CYCLES ? 'error' : 'warn',
        `⚠️  ZERO_ACCOUNTS: ${state.consecutiveZeroCycles} consecutive cycle(s) returned no ` +
          `observation accounts. close_observation is permissionless so a brief gap can be ` +
          `legitimate, but a sustained one means the query stopped matching — and the accounts ` +
          `are being swept off the chain meanwhile.`
      );
    } else {
      state.consecutiveZeroCycles = 0;
    }

    log(
      classification.status === 'ok' ? 'info' : 'error',
      `${classification.status === 'ok' ? '✅' : '⚠️ '} slot ${contextSlot} · ` +
        `${accounts.length} accounts · +${result.inserted} new · ${result.updated} seen · ` +
        `${result.revisions} revised · ${result.stale} stale-refused · ` +
        `${unparsed.length} unparsed (${repeatedUnparsed} repeat) · ` +
        `${classification.status}${classification.anomaly ? ` ${classification.anomaly}` : ''} · ` +
        `${finishedAt - startedAt}ms`
    );
  } catch (error) {
    state.consecutiveFailures++;
    const scrubbed = scrubSecrets(error);
    const sustained = state.consecutiveFailures >= 3;
    const finishedAt = Date.now();

    if (runId !== null) {
      safeWrite('finishPollRun(failed)', () =>
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
        })
      );
    }

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
  console.log(`Consecutive unhealthy runs: ${failures}`);
  db.close();
}

/**
 * Seed the per-process state from the database.
 *
 * Both fields used to start at zero, which meant the first cycle after every
 * restart could neither detect a lagging replica (`lastContextSlot = 0`
 * disables the check, at exactly the moment a cold replica is most likely)
 * nor skip the hourly canary (`lastCanaryAt = 0` forces one) — so a flapping
 * supervisor, or repeated `--once` invocations, doubled the RPC budget
 * permanently.
 */
export function seedState(db: Database): DaemonState {
  const slotRow = db
    .prepare<[], { slot: number | null }>(
      `SELECT MAX(slot) AS slot FROM (
         SELECT MAX(last_seen_slot) AS slot FROM observations
         UNION ALL
         SELECT MAX(context_slot) AS slot FROM poll_runs
       )`
    )
    .get();

  const canaryRow = db
    .prepare<
      [],
      { at: number | null }
    >('SELECT MAX(started_at) AS at FROM poll_runs WHERE canary_count IS NOT NULL')
    .get();

  return {
    lastContextSlot: slotRow?.slot ?? 0,
    consecutiveZeroCycles: 0,
    consecutiveFailures: 0,
    lastCanaryAt: canaryRow?.at ?? 0,
    lastSchemaMajor: null,
    stopping: false,
  };
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

  const state = seedState(db);
  safeWrite('prunePollRuns', () => prunePollRuns(db, pollRunRetentionMs()));

  let timer: NodeJS.Timeout | null = null;
  let cycleInFlight = false;

  const finish = (): void => {
    try {
      lock.release();
    } catch {
      // Losing the lock row on the way out costs a takeover, not data.
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
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

  // Last resort. Node's default for an unhandled rejection is to terminate the
  // process, and a terminated daemon leaves a lock behind. Continuous capture
  // is worth more than strictness here: log it and let the next cycle run.
  process.on('unhandledRejection', (reason) => {
    log('error', `❌ unhandled rejection (capture continues): ${scrubSecrets(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    log('error', `❌ uncaught exception (capture continues): ${scrubSecrets(error)}`);
  });

  // Self-scheduling: the next cycle is armed only after this one completes,
  // so ticks can never overlap.
  const loop = async (): Promise<void> => {
    const started = Date.now();
    try {
      cycleInFlight = true;
      await runCycle(db, client, state);
    } catch (error) {
      // runCycle catches everything itself; this is belt and braces so a
      // future edit inside it cannot silently become a process-killer.
      log('error', `❌ cycle escaped its own handler: ${scrubSecrets(error)}`);
    } finally {
      cycleInFlight = false;
    }

    safeWrite('lock heartbeat', () => lock.heartbeat());

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

// Only run as a program. Importing this module (tests do, for `seedState`)
// must not start a daemon.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`❌ capture failed to start: ${scrubSecrets(error)}`);
    process.exit(1);
  });
}
