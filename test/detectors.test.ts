/**
 * Detectors, against the epoch-511 fixture.
 *
 * The fixture is the real structure: 17 observations, 11 distinct report
 * transactions, 7 observers sharing one report, and those 7 blobs distinct but
 * ~98% byte-identical. If a detector cannot find that group, it cannot find
 * the thing this capability was built for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedReportTxDetector } from '../src/observers/detectors/shared-report-tx.js';
import { identicalResultsDetector } from '../src/observers/detectors/identical-results.js';
import { nearIdenticalResultsDetector } from '../src/observers/detectors/near-identical-results.js';
import { coSubmissionTimingDetector } from '../src/observers/detectors/co-submission-timing.js';
import { DETECTORS, EPOCH_DETECTORS, WINDOW_DETECTORS } from '../src/observers/detectors/index.js';
import type { DetectorConfig, DetectorContext, EpochSnapshot } from '../src/observers/types.js';
import {
  GATEWAY_COUNT,
  MEANINGFUL_BYTES,
  SHARED_REPORT_OBSERVERS,
  SHARED_REPORT_TX,
  blob,
  epoch511Observations,
  epochSnapshot,
  observationRecord,
} from './helpers.js';

const config: DetectorConfig = {
  similarityThreshold: 0.9,
  calibrated: false,
  calibrationId: null,
  coSubmissionWindowSeconds: 60,
  sharedAsnMinObservers: 4,
  persistentMinEpochs: 3,
  compositeMinKinds: 2,
  windowEpochs: 30,
  detectorVersion: 1,
};

function context(epoch: EpochSnapshot, overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    epoch,
    epochs: [epoch],
    gateways: new Map(),
    gatewaySnapshotAt: null,
    config,
    now: 1_760_100_000_000,
    priorFindings: [],
    ...overrides,
  };
}

test('every v1 detector treats the result blob as opaque bytes', () => {
  assert.equal(DETECTORS.length, 12);
  for (const detector of DETECTORS) {
    assert.equal(
      detector.requiresDecodedResults,
      false,
      `${detector.kind} must not claim to interpret the bitmap`
    );
  }
  assert.equal(EPOCH_DETECTORS.length + WINDOW_DETECTORS.length, DETECTORS.length);
});

test('shared_report_tx finds the seven observers behind one report', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const findings = sharedReportTxDetector.run(context(epoch));

  assert.equal(findings.length, 1, 'only the shared group, not the ten independent reports');
  const [finding] = findings;
  assert.equal(finding.kind, 'shared_report_tx');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.confidence, 1, 'an exact identity needs no inference');
  assert.equal(finding.epochIndex, 511);
  assert.deepEqual(finding.observers, [...SHARED_REPORT_OBSERVERS].sort());
  assert.equal(finding.detail.reportTxId, SHARED_REPORT_TX);
  assert.equal(finding.detail.observerCount, 7);
  assert.equal(finding.detail.epochObservationCount, 17);
  assert.equal(finding.detail.epochDistinctReportTxIds, 11);
});

test('identical_results finds nothing when every blob is distinct', () => {
  const epoch = epochSnapshot(epoch511Observations());
  assert.deepEqual(identicalResultsDetector.run(context(epoch)), []);
});

test('identical_results groups byte-identical blobs at full confidence', () => {
  const shared = blob(0xa5);
  const epoch = epochSnapshot([
    observationRecord({ observer: 'a', gatewayResults: shared, reportTxId: 'tx-a' }),
    observationRecord({ observer: 'b', gatewayResults: Buffer.from(shared), reportTxId: 'tx-b' }),
    observationRecord({ observer: 'c', gatewayResults: blob(0x5a), reportTxId: 'tx-c' }),
  ]);

  const findings = identicalResultsDetector.run(context(epoch));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].observers, ['a', 'b']);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].confidence, 1);
  assert.equal(findings[0].detail.meaningfulBytes, MEANINGFUL_BYTES);
  assert.deepEqual(findings[0].detail.reportTxIds, ['tx-a', 'tx-b']);
});

test('identical_results refuses to group on zero comparable bytes', () => {
  // gatewayCount 0 makes every blob hash to the digest of an empty buffer.
  // decode() rejects such accounts now; this is the second line of defence,
  // because this detector is the one that emits high/1.0.
  const epoch = epochSnapshot([
    observationRecord({ observer: 'a', gatewayCount: 0, gatewayResults: blob(0xff) }),
    observationRecord({ observer: 'b', gatewayCount: 0, gatewayResults: blob(0x00) }),
  ]);

  assert.deepEqual(identicalResultsDetector.run(context(epoch)), []);
});

test('near_identical_results recovers the seven distinct-but-similar blobs', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const findings = nearIdenticalResultsDetector.run(context(epoch));

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.deepEqual(finding.observers, [...SHARED_REPORT_OBSERVERS].sort());
  assert.equal(finding.detail.allBlobsDistinct, true, 'equality would have found nothing here');
  assert.equal(finding.detail.gatewayCount, GATEWAY_COUNT);
  assert.equal(finding.detail.meaningfulBytes, MEANINGFUL_BYTES);
  assert.ok((finding.detail.minSimilarity as number) >= 0.9);
  assert.ok((finding.detail.maxSimilarity as number) < 1);
});

test('an uncalibrated threshold caps severity and says so in the data', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const [uncalibrated] = nearIdenticalResultsDetector.run(context(epoch));

  assert.equal(uncalibrated.severity, 'medium');
  assert.equal(uncalibrated.confidence, 0.5);
  assert.equal(uncalibrated.detail.calibrated, false);
  assert.equal(uncalibrated.detail.thresholdProvenance, 'uncalibrated-default');
  assert.match(uncalibrated.summary, /uncalibrated/);

  const [calibrated] = nearIdenticalResultsDetector.run(
    context(epoch, { config: { ...config, calibrated: true, calibrationId: 7 } })
  );
  assert.equal(calibrated.severity, 'high');
  assert.equal(calibrated.confidence, 0.9);
  assert.equal(calibrated.detail.calibrationId, 7);
});

test('co_submission_timing clusters submissions inside the window', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const findings = coSubmissionTimingDetector.run(context(epoch));

  // The seven shared-report observers submit 3s apart; the ten independents
  // are 600s apart and must not be swept in.
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].observers, [...SHARED_REPORT_OBSERVERS].sort());
});

test('finding ids are deterministic and observer order cannot churn them', () => {
  const forward = epoch511Observations();
  const reversed = [...forward].reverse();

  const a = sharedReportTxDetector.run(context(epochSnapshot(forward)))[0];
  const b = sharedReportTxDetector.run(context(epochSnapshot(reversed)))[0];

  assert.equal(a.id, b.id, 'ids must survive a reordered RPC response');
  assert.deepEqual(a.observers, b.observers);
  assert.match(a.id, /^shared_report_tx:511:[0-9a-f]{12}$/);
});

test('a single observation produces no findings at all', () => {
  const epoch = epochSnapshot([observationRecord({ observer: 'lonely' })]);
  for (const detector of EPOCH_DETECTORS) {
    assert.deepEqual(detector.run(context(epoch)), [], `${detector.kind} fired on one observation`);
  }
});

// --- published payload is bounded -------------------------------------------
// The pairwise matrix is O(n^2) in an epoch's observer count (protocol cap 50
// => 1225 pairs). Before the cap, one 15-observer component published ~19 KiB
// of pairs inside a document that accumulated every epoch. These assert the
// bound holds, and that truncation is disclosed rather than silent.
test('near_identical_results caps published pairs and reports the truncation', () => {
  const n = 12; // 66 pairs, comfortably over the limit of 20
  const observations = Array.from({ length: n }, (_, i) => {
    const results = blob(0xff);
    results[i % MEANINGFUL_BYTES] ^= 0x01; // near-identical, one bit apart
    return observationRecord({
      observer: `obs${String(i).padStart(2, '0')}`,
      gatewayResults: results,
      reportTxId: `tx${i}`,
    });
  });

  const [finding] = nearIdenticalResultsDetector.run(context(epochSnapshot(observations)));
  assert.ok(finding, 'expected a near_identical_results finding');

  const pairs = finding.detail.pairs as Array<{ a: number; b: number; similarity: number }>;
  assert.ok(pairs.length <= 20, `published ${pairs.length} pairs, expected <= 20`);
  assert.equal(finding.detail.pairsTotal, (n * (n - 1)) / 2);
  assert.equal(
    finding.detail.pairsTruncated,
    (finding.detail.pairsTotal as number) - pairs.length
  );

  // Indices into `observers`, not repeated 43-char keys.
  for (const pair of pairs) {
    assert.equal(typeof pair.a, 'number');
    assert.ok(finding.observers[pair.a] !== undefined, 'pair index must resolve');
    assert.ok(finding.observers[pair.b] !== undefined, 'pair index must resolve');
  }

  // The excerpt must be the strongest evidence, not an arbitrary slice.
  const sims = pairs.map((pair) => pair.similarity);
  assert.deepEqual(sims, [...sims].sort((x, y) => y - x));
});
