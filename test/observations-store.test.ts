/**
 * The observation store.
 *
 * The two properties under test are the ones a silent violation of would
 * corrupt everything downstream without ever failing a build:
 *
 *  - IDEMPOTENCY: re-reading the same account forever must not churn the row.
 *  - MONOTONICITY: a lagging RPC replica must never overwrite newer data with
 *    older data. The newer bytes would survive only in `observation_revisions`,
 *    which nothing reads, so every published score would be computed from the
 *    older blob.
 *
 * Plus the keying rule the whole schema turns on: `(epoch_index, observer)`,
 * because `report_tx_id` is NOT unique — seven epoch-511 observers shared one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquirePollLock,
  activateCalibration,
  duplicateObservationKeys,
  insertRawUnparsed,
  insertRegistrySlots,
  prunePollRuns,
  upsertObservation,
  upsertObservations,
} from '../src/db/repo-write.js';
import { getEpoch, listEpochs, listFindings, upsertFindings } from '../src/db/repo-read.js';
import {
  SHARED_REPORT_OBSERVERS,
  SHARED_REPORT_TX,
  blob,
  decodedObservation,
  flipBits,
  memoryDb,
} from './helpers.js';
import type { Finding } from '../src/observers/types.js';

test('an unchanged re-read is idempotent: no revision, no churn', () => {
  const db = memoryDb();
  const record = decodedObservation();

  assert.equal(upsertObservation(db, record, 1000, 500), 'inserted');
  for (let cycle = 0; cycle < 5; cycle++) {
    assert.equal(upsertObservation(db, record, 1000 + cycle, 500 + cycle), 'updated');
  }

  const row = db.prepare('SELECT revision, last_seen_slot FROM observations').get() as {
    revision: number;
    last_seen_slot: number;
  };
  assert.equal(row.revision, 1, 'an unchanged read must not bump the revision');
  assert.equal(row.last_seen_slot, 504, 'provenance still advances');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM observation_revisions').get() as { n: number }).n,
    0
  );
  db.close();
});

test('a genuine chain update is recorded as a revision', () => {
  const db = memoryDb();
  const first = decodedObservation({ reportTxId: 'OLD', submittedAt: 1000 });
  const second = decodedObservation({
    reportTxId: 'NEW',
    submittedAt: 2000,
    gatewayResults: blob(0x11),
  });

  assert.equal(upsertObservation(db, first, 1_000, 900), 'inserted');
  assert.equal(upsertObservation(db, second, 2_000, 1000), 'revised');

  const row = db.prepare('SELECT report_tx_id, submitted_at, revision FROM observations').get() as {
    report_tx_id: string;
    submitted_at: number;
    revision: number;
  };
  assert.equal(row.report_tx_id, 'NEW');
  assert.equal(row.submitted_at, 2000);
  assert.equal(row.revision, 2);

  const revision = db
    .prepare('SELECT report_tx_id, changed_fields FROM observation_revisions')
    .get() as { report_tx_id: string; changed_fields: string };
  assert.equal(revision.report_tx_id, 'OLD', 'the superseded state is what gets archived');
  assert.deepEqual(JSON.parse(revision.changed_fields).sort(), [
    'gateway_results',
    'report_tx_id',
    'submitted_at',
  ]);
  db.close();
});

test('MONOTONICITY: an older submittedAt never overwrites a newer row', () => {
  const db = memoryDb();
  const newer = decodedObservation({
    reportTxId: 'NEW',
    submittedAt: 2000,
    gatewayResults: blob(0x11),
  });
  const older = decodedObservation({
    reportTxId: 'OLD',
    submittedAt: 1000,
    gatewayResults: blob(0x22),
  });

  assert.equal(upsertObservation(db, newer, 2_000, 1000), 'inserted');
  assert.equal(
    upsertObservation(db, older, 3_000, 900),
    'stale',
    'a lagging replica must be refused, not archived'
  );

  const row = db
    .prepare('SELECT report_tx_id, submitted_at, revision, last_seen_slot FROM observations')
    .get() as {
    report_tx_id: string;
    submitted_at: number;
    revision: number;
    last_seen_slot: number;
  };
  assert.equal(row.report_tx_id, 'NEW', 'the newer observation survives in the live table');
  assert.equal(row.submitted_at, 2000);
  assert.equal(row.revision, 1, 'a refused read is not a revision');
  assert.equal(row.last_seen_slot, 1000, 'provenance must not regress either');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM observation_revisions').get() as { n: number }).n,
    0
  );
  db.close();
});

test('MONOTONICITY: a read from an older slot never overwrites a newer row', () => {
  const db = memoryDb();
  // Same chain timestamp, but read at an older context slot — the other way a
  // replica behind the one we already read from shows up.
  const stored = decodedObservation({ reportTxId: 'A', gatewayResults: blob(0x11) });
  const fromLaggingReplica = decodedObservation({ reportTxId: 'B', gatewayResults: blob(0x22) });

  upsertObservation(db, stored, 1_000, 5000);
  assert.equal(upsertObservation(db, fromLaggingReplica, 2_000, 4999), 'stale');

  const row = db.prepare('SELECT report_tx_id FROM observations').get() as { report_tx_id: string };
  assert.equal(row.report_tx_id, 'A');
  db.close();
});

test('a stale read still refreshes provenance when the data agrees', () => {
  const db = memoryDb();
  const record = decodedObservation();

  upsertObservation(db, record, 1_000, 5000);
  assert.equal(upsertObservation(db, record, 2_000, 4000), 'updated');

  const row = db.prepare('SELECT last_seen_at, last_seen_slot FROM observations').get() as {
    last_seen_at: number;
    last_seen_slot: number;
  };
  assert.equal(row.last_seen_slot, 5000, 'MAX(), never a regression');
  assert.equal(row.last_seen_at, 2000);
  db.close();
});

test('SEVEN observers sharing ONE reportTxId keep seven rows (real epoch 511)', () => {
  const db = memoryDb();
  const base = blob(0xa5);

  const records = SHARED_REPORT_OBSERVERS.map((observer, index) =>
    decodedObservation({
      epochIndex: 511,
      observer,
      reportTxId: SHARED_REPORT_TX, // the same transaction for all seven
      gatewayResults: flipBits(base, 8 + index, index * 17),
      submittedAt: 1_760_000_000 + index,
    })
  );

  const result = upsertObservations(db, records, 1_000, 500);
  assert.equal(result.inserted, 7);
  assert.equal(result.updated, 0);
  assert.equal(result.revisions, 0);
  assert.equal(result.duplicateKeys, 0);

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS rows, COUNT(DISTINCT observer) AS observers,
              COUNT(DISTINCT report_tx_id) AS reports,
              COUNT(DISTINCT gateway_results) AS blobs
         FROM observations WHERE epoch_index = 511`
    )
    .get() as { rows: number; observers: number; reports: number; blobs: number };

  assert.equal(counts.rows, 7, 'a shared report tx must NOT collapse rows');
  assert.equal(counts.observers, 7);
  assert.equal(counts.reports, 1, 'one report transaction, seven observers');
  assert.equal(counts.blobs, 7, 'and seven DISTINCT blobs — equality finds nothing here');

  // Re-reading the same seven accounts forever changes nothing.
  const again = upsertObservations(db, records, 2_000, 600);
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 7);
  assert.equal(again.revisions, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 7);

  const epoch = getEpoch(db, 511);
  assert.equal(epoch?.observations.length, 7);
  assert.equal(epoch?.distinctReportTxIds, 1);
  db.close();
});

test('two accounts claiming one (epoch, observer) are counted, not silently merged', () => {
  const db = memoryDb();
  const a = decodedObservation({ pubkey: 'ACCOUNT_A', reportTxId: 'TXA' });
  const b = decodedObservation({ pubkey: 'ACCOUNT_B', reportTxId: 'TXB' });

  assert.deepEqual(duplicateObservationKeys([a, b]), ['511|observer-1']);

  const result = upsertObservations(db, [a, b], 1_000, 500);
  assert.equal(result.duplicateKeys, 1, 'the collapse must be observable');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 1);
  db.close();
});

test('undecodable bytes are parked once, then counted', () => {
  const db = memoryDb();
  const bytes = Buffer.from('not an observation account');

  assert.equal(insertRawUnparsed(db, 'PDA1', bytes, 'bad_size', 1000, 10), 'inserted');
  for (let cycle = 0; cycle < 143; cycle++) {
    assert.equal(insertRawUnparsed(db, 'PDA1', bytes, 'bad_size', 2000 + cycle, 20), 'repeated');
  }

  const row = db
    .prepare('SELECT COUNT(*) AS n, MAX(seen_count) AS seen FROM raw_unparsed')
    .get() as {
    n: number;
    seen: number;
  };
  assert.equal(row.n, 1, 'a day of re-reads must not be a day of rows');
  assert.equal(row.seen, 144);

  // Different bytes from the same account are a different sample.
  assert.equal(
    insertRawUnparsed(db, 'PDA1', Buffer.from('other'), 'bad_size', 3000, 30),
    'inserted'
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM raw_unparsed').get() as { n: number }).n, 2);
  db.close();
});

test('an out-of-epoch registry snapshot is never reported as decodable', () => {
  const db = memoryDb();
  upsertObservations(
    db,
    [
      decodedObservation({ epochIndex: 510, observer: 'a' }),
      decodedObservation({ epochIndex: 511, observer: 'a' }),
    ],
    1000,
    500
  );

  const snapshot = {
    gatewayCount: 2,
    capturedAt: 1000,
    capturedAtSlot: 500,
    registryPubkey: 'REGISTRY',
    digest: 'deadbeef',
    slots: ['gw-a', 'gw-b'],
  };

  // 511 is live; 510 already closed when we got to it.
  insertRegistrySlots(db, { ...snapshot, epochIndex: 511, inEpoch: true });
  insertRegistrySlots(db, { ...snapshot, epochIndex: 510, inEpoch: false });

  const epochs = listEpochs(db);
  const e510 = epochs.find((e) => e.epochIndex === 510);
  const e511 = epochs.find((e) => e.epochIndex === 511);

  assert.equal(e511?.registryCaptured, true);
  assert.equal(e511?.registryApproximate, false);
  assert.equal(e510?.registryCaptured, false, 'a backfilled slot order is not a captured one');
  assert.equal(e510?.registryApproximate, true);
  assert.equal(getEpoch(db, 510)?.registry?.inEpoch, false);
  db.close();
});

test('the capture lock refuses a live holder and takes over a dead one', () => {
  const db = memoryDb();

  const first = acquirePollLock(db, 4242, 'host-a', 60_000, () => false);
  assert.equal(first.acquired, true);

  const second = acquirePollLock(db, 4343, 'host-a', 60_000, () => false);
  assert.equal(second.acquired, false, 'a live heartbeat must refuse a second daemon');
  assert.equal(second.heldBy?.pid, 4242);

  // Same host, but the recorded pid no longer exists: a SIGKILLed daemon must
  // not lock its own supervisor out for three intervals.
  const third = acquirePollLock(db, 4444, 'host-a', 60_000, (holder) => holder.pid === 4242);
  assert.equal(third.acquired, true);
  assert.equal(third.tookOverDead, true);
  db.close();
});

test('poll runs are pruned by age, and a running row is never dropped', () => {
  const db = memoryDb();
  const now = 1_000_000_000_000;
  const insert = db.prepare('INSERT INTO poll_runs (started_at, status) VALUES (?, ?)');
  insert.run(now - 40 * 86_400_000, 'ok');
  insert.run(now - 1 * 86_400_000, 'ok');
  insert.run(now - 90 * 86_400_000, 'running');

  const deleted = prunePollRuns(db, 30 * 86_400_000, now);
  assert.equal(deleted, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM poll_runs').get() as { n: number }).n, 2);
  db.close();
});

test('listFindings returns observers for exactly the findings it returns', () => {
  const db = memoryDb();
  const finding = (id: string, epochIndex: number | null, observers: string[]): Finding => ({
    id,
    kind: 'shared_report_tx',
    epochIndex,
    observers,
    severity: 'high',
    confidence: 1,
    detectedAt: new Date(0).toISOString(),
    summary: `finding ${id}`,
    detail: {},
  });

  upsertFindings(
    db,
    [
      finding('a', 510, ['obs-1', 'obs-2']),
      finding('b', 511, ['obs-3']),
      finding('c', null, ['obs-1', 'obs-3']),
    ],
    1,
    [510, 511],
    true
  );

  const only511 = listFindings(db, { epochIndexes: [511], includeCrossEpoch: false });
  assert.deepEqual(
    only511.map((f) => f.id),
    ['b']
  );
  assert.deepEqual(only511[0].observers, ['obs-3']);

  const all = listFindings(db);
  assert.equal(all.length, 3);
  assert.deepEqual(all.find((f) => f.id === 'a')?.observers, ['obs-1', 'obs-2']);
});

test('recomputing a window prunes findings for epochs that fell out of it', () => {
  const db = memoryDb();
  const finding = (id: string, epochIndex: number): Finding => ({
    id,
    kind: 'unmatched_observer',
    epochIndex,
    observers: ['obs-1'],
    severity: 'info',
    confidence: 1,
    detectedAt: new Date(0).toISOString(),
    summary: id,
    detail: {},
  });

  upsertFindings(db, [finding('old', 400), finding('new', 511)], 1, [400, 511], true);
  assert.equal(listFindings(db).length, 2);

  // The next cycle's window no longer contains epoch 400.
  upsertFindings(db, [finding('new', 511)], 1, [511], true);
  const remaining = listFindings(db);
  assert.deepEqual(
    remaining.map((f) => f.id),
    ['new']
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM finding_observers').get() as { n: number }).n,
    1,
    'orphaned observer rows go with them'
  );
  db.close();
});

test('a NO_SEPARATION calibration cannot be activated without --force', () => {
  const db = memoryDb();
  const insert = db.prepare(
    `INSERT INTO calibration (
       computed_at, epoch_from, epoch_to, epoch_count, pair_count, independent_pairs,
       recommended_threshold, active, notes, separates
     ) VALUES (?, 500, 514, 15, 100, 90, 0.9, 0, ?, ?)`
  );
  const useless = Number(insert.run(1, 'NO_SEPARATION', 0).lastInsertRowid);
  const useful = Number(insert.run(1, 'ok', 1).lastInsertRowid);

  assert.deepEqual(activateCalibration(db, 9999), { ok: false, reason: 'not_found' });
  assert.deepEqual(activateCalibration(db, useless), { ok: false, reason: 'no_separation' });
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM calibration WHERE active = 1').get() as { n: number }).n,
    0,
    'a refused activation must not touch the active flag'
  );

  assert.deepEqual(activateCalibration(db, useful), { ok: true });
  assert.deepEqual(activateCalibration(db, useless, { force: true }), { ok: true });
  const active = db.prepare('SELECT id FROM calibration WHERE active = 1').all() as Array<{
    id: number;
  }>;
  assert.deepEqual(
    active.map((r) => r.id),
    [useless],
    'activation is exclusive'
  );
  db.close();
});
