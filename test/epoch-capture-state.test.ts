/**
 * Capture completeness, and the epoch documents that only exist because of it.
 *
 * The bug this covers: `/api/v1/epochs/554.json` returned 404 because epoch 554
 * (2026-09-24) produced no observations, so no document was written. A 404 there
 * is indistinguishable from "wrong URL", "epoch hasn't happened" and "publisher
 * bug" — while the chain actually told us something specific: 50 prescribed
 * observers, `observations_submitted: 0`, an all-zero `has_observed` bitmap.
 *
 * The trap, found in the live data before writing this: epochs 508 and 509 ALSO
 * have zero captured observations, but the chain says 10 and 8 were submitted —
 * capture simply had not started. Publishing those as an empty list would state
 * "nobody observed" for epochs where ten observers did. So the empty document
 * is only honest with `capture` attached, and these tests pin that.
 *
 * No network, no DB: the state function is pure and the builder takes plain
 * facts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureState,
  isProvablyUnobserved,
  isWindowClosed,
} from '../src/observers/capture-state.js';
import { buildUnobservedEpochDocument } from '../src/observers/documents.js';
import { SCHEMA_VERSION } from '../src/publish/contract.js';
import type { ChainEpochFacts } from '../src/db/repo-read.js';

/** Epoch 554's real window: 2026-09-24, long closed. */
const CLOSED_END = Math.floor(Date.parse('2026-09-25T00:04:10Z') / 1000);

const chainFacts = (over: Partial<ChainEpochFacts> = {}): ChainEpochFacts => ({
  epochIndex: 554,
  endTimestamp: CLOSED_END,
  totalCompositeWeight: null,
  hashchain: null,
  observationsClosed: null,
  layoutVersion: null,
  failureCounts: null,
  observerCount: 50,
  observationsSubmitted: 0,
  activeGatewayCount: 580,
  hasObservedCount: 0,
  ...over,
});

// --- captureState -----------------------------------------------------------

test('0 captured of 0 submitted is complete, not missing', () => {
  // Epoch 554: the whole point. Nothing to capture means we captured it all.
  assert.equal(captureState(0, 0), 'complete');
});

test('0 captured of 10 submitted is missing, never complete', () => {
  // Epochs 508/509. Publishing this as an ordinary empty list would lie.
  assert.equal(captureState(0, 10), 'missing');
});

test('fewer captured than submitted is partial', () => {
  // Epoch 520 on the live box: 16 captured, chain counted 18.
  assert.equal(captureState(16, 18), 'partial');
});

test('exactly as many as submitted is complete', () => {
  assert.equal(captureState(30, 30), 'complete');
});

test('no chain count is unknown, not an optimistic complete', () => {
  // Claiming completeness we cannot verify is the failure this field exists
  // to prevent.
  assert.equal(captureState(0, null), 'unknown');
  assert.equal(captureState(30, null), 'unknown');
});

test('more captured than the chain counted reports complete, not an error', () => {
  // `observations_submitted` is a running tally on a live epoch, so a later
  // capture legitimately holds more than an earlier read of the counter.
  assert.equal(captureState(31, 30), 'complete');
});

test('isProvablyUnobserved requires the chain to corroborate', () => {
  assert.equal(isProvablyUnobserved(0), true);
  assert.equal(isProvablyUnobserved(10), false);
  assert.equal(isProvablyUnobserved(null), false, 'unknown is not proof');
});

// --- buildUnobservedEpochDocument -------------------------------------------

test('a provably quiet epoch publishes an empty but complete document', () => {
  const doc = buildUnobservedEpochDocument(chainFacts(), []);

  assert.equal(doc.epochIndex, 554);
  assert.equal(doc.observationCount, 0);
  assert.deepEqual(doc.observations, []);
  assert.equal(doc.capture, 'complete');
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  // The chain block is what lets a consumer verify `capture` instead of
  // trusting it.
  assert.deepEqual(doc.chain, {
    endTimestampUnix: CLOSED_END,
    totalCompositeWeight: null,
    hashchain: null,
    observationsClosed: null,
    layoutVersion: null,
    observerCount: 50,
    observationsSubmitted: 0,
    activeGatewayCount: 580,
    hasObservedCount: 0,
  });
});

test('an epoch whose observations were lost is published as missing', () => {
  // Epoch 508: chain counted 10, we hold none.
  const doc = buildUnobservedEpochDocument(
    chainFacts({ epochIndex: 508, observationsSubmitted: 10, hasObservedCount: 10 }),
    [],
  );

  assert.equal(doc.capture, 'missing');
  assert.deepEqual(doc.observations, []);
  assert.equal(
    doc.chain?.observationsSubmitted,
    10,
    'the document must still say that ten reports existed',
  );
});

test('submission timestamps are null, not Infinity', () => {
  // `getEpoch()` computes Math.min(...submitted), which is Infinity on an empty
  // array. That is exactly why this builder bypasses it.
  const doc = buildUnobservedEpochDocument(chainFacts(), []);
  assert.equal(doc.firstSubmittedAtUnix, null);
  assert.equal(doc.lastSubmittedAtUnix, null);
  for (const v of [doc.firstSubmittedAtUnix, doc.lastSubmittedAtUnix]) {
    assert.ok(v === null || Number.isFinite(v), 'never Infinity');
  }
});

test('registry provenance is reported absent, not guessed', () => {
  const doc = buildUnobservedEpochDocument(chainFacts(), []);
  assert.equal(doc.registryCaptured, false);
  assert.equal(doc.registryApproximate, false);
  assert.equal(doc.registryDigest, null);
});

test('findings for the epoch are still attached, and others are not', () => {
  // A finding can be about the epoch itself rather than any observation.
  const finding = (epochIndex: number | null, id: string) =>
    ({
      id,
      kind: 'test_kind',
      epochIndex,
      observers: [],
      severity: 'info',
      confidence: 1,
      detectedAt: Date.now(),
      summary: 's',
      detail: {},
    }) as never;

  const doc = buildUnobservedEpochDocument(chainFacts(), [
    finding(554, 'mine'),
    finding(553, 'other-epoch'),
    finding(null, 'network-wide'),
  ]);

  assert.deepEqual(
    doc.findings.map((f) => f.id),
    ['mine'],
  );
});

// --- the live epoch ---------------------------------------------------------

test('isWindowClosed compares against the epoch end, not a guess at length', () => {
  const end = 1_759_190_650; // 2026-09-30T00:04:10Z
  assert.equal(isWindowClosed(end, (end - 60) * 1000), false, 'a minute before close');
  assert.equal(isWindowClosed(end, end * 1000), true, 'exactly at close');
  assert.equal(isWindowClosed(end, (end + 60) * 1000), true, 'after close');
  assert.equal(isWindowClosed(null, Date.now()), null, 'no end timestamp is not a guess');
});

test('a still-running epoch is unknown, never complete', () => {
  // The bug this guards: epoch 560 was 46 minutes into a 24-hour window with 0
  // observations, and captureState(0, 0) said `complete` — publishing "nobody
  // reported" about an epoch nobody had had time to report on.
  assert.equal(captureState(0, 0, false), 'unknown');
  assert.equal(captureState(34, 34, false), 'unknown', 'also while reports are arriving');
  assert.equal(captureState(0, 10, false), 'unknown', 'a live epoch is not yet "missing"');
});

test('an unknown window is unknown, not an assumption either way', () => {
  assert.equal(captureState(0, 0, null), 'unknown');
});

test('a closed window still judges exactly as before', () => {
  assert.equal(captureState(0, 0, true), 'complete');
  assert.equal(captureState(0, 10, true), 'missing');
  assert.equal(captureState(16, 18, true), 'partial');
});

test('the live epoch publishes as unknown with its end timestamp exposed', () => {
  // A consumer must be able to tell "unknown because running" from "unknown
  // because no tally", so the end timestamp rides along in `chain`.
  const future = Math.floor(Date.now() / 1000) + 3600;
  const doc = buildUnobservedEpochDocument(
    chainFacts({ epochIndex: 560, endTimestamp: future }),
    [],
  );
  assert.equal(doc.capture, 'unknown');
  assert.deepEqual(doc.observations, []);
  assert.equal(doc.chain?.endTimestampUnix, future);
  assert.ok(
    (doc.chain?.endTimestampUnix ?? 0) * 1000 > Date.now(),
    'a future end timestamp is what marks it live',
  );
});

test('a closed-step flag of false does not override an elapsed window', () => {
  // Measured on chain 2026-09-30: epochs 553 and 554 ended days earlier and
  // still reported observationsClosed:false, because nothing had cranked them
  // closed. Letting the flag win would mark them `unknown` forever.
  const doc = buildUnobservedEpochDocument(
    chainFacts({ epochIndex: 554, observationsClosed: false, endTimestamp: CLOSED_END }),
    [],
  );
  assert.equal(doc.capture, 'complete');
});

test('the closed-step flag alone can close a window', () => {
  // The flag is a positive signal: if the protocol says closed, it is closed,
  // even with an end timestamp still in the future.
  const future = Math.floor(Date.now() / 1000) + 3600;
  const doc = buildUnobservedEpochDocument(
    chainFacts({ observationsClosed: true, endTimestamp: future }),
    [],
  );
  assert.equal(doc.capture, 'complete');
});

test('neither signal closed means the epoch is live and unknown', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const doc = buildUnobservedEpochDocument(
    chainFacts({ epochIndex: 560, observationsClosed: false, endTimestamp: future }),
    [],
  );
  assert.equal(doc.capture, 'unknown');
});

test('the new chain fields reach the document', () => {
  const doc = buildUnobservedEpochDocument(
    chainFacts({
      totalCompositeWeight: '1797819500',
      hashchain: '80c8f132c34b0b1d',
      layoutVersion: '1.0.0',
      failureCounts: [1, 0, 2],
    }),
    [],
  );
  assert.equal(doc.chain?.totalCompositeWeight, '1797819500');
  assert.equal(doc.chain?.hashchain, '80c8f132c34b0b1d');
  assert.equal(doc.chain?.layoutVersion, '1.0.0');
  assert.deepEqual(doc.failureCounts, [1, 0, 2]);
});

test('a null chain block yields unknown rather than a false complete', () => {
  const doc = buildUnobservedEpochDocument(
    chainFacts({ observationsSubmitted: null, observerCount: null, hasObservedCount: null }),
    [],
  );
  assert.equal(doc.capture, 'unknown');
});

test('the document is JSON-serialisable with no undefined holes', () => {
  // It is written straight to disk and served; an undefined would vanish
  // silently and take a required field with it.
  const doc = buildUnobservedEpochDocument(chainFacts(), []);
  const round = JSON.parse(JSON.stringify(doc));
  for (const key of ['capture', 'chain', 'observations', 'observationCount', 'epochIndex']) {
    assert.ok(key in round, `${key} survives serialisation`);
  }
  assert.equal(round.capture, 'complete');
});
