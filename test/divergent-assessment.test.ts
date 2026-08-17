/**
 * The divergent-assessment detector.
 *
 * This is the only detector that interprets bitmap CONTENT, so the properties
 * worth pinning are the ones whose violation would produce a confident,
 * plausible, wrong finding:
 *
 *  - POLARITY INVARIANCE: inverting every bitmap must not change the finding.
 *    If it did, the detector would silently depend on a bit convention it has
 *    no way to verify, and a protocol change would flip its conclusions
 *    without failing anything.
 *  - NO FIRING ON ORDINARY SPREAD: a single continuous population must not be
 *    split just because someone sits at the edge of it.
 *  - BOTH SIDES REPORTED: the finding is the disagreement. Naming only one
 *    group would assert which side is correct, which the data cannot support.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { divergentAssessmentDetector } from '../src/observers/detectors/divergent-assessment.js';
import { epochSnapshot, observationRecord, GATEWAY_COUNT, BLOB_BYTES } from './helpers.js';
import type { DetectorContext } from '../src/observers/types.js';

interface Group { count: number; meanDensity: number; spread: number; observers: string[] }
interface SplitDetail { gap: number; observerCount: number; low: Group; high: Group }

/** A bitmap whose first `failures` meaningful bits are CLEAR, rest SET. */
function bitmapWithFailures(failures: number): Buffer {
  const buf = Buffer.alloc(BLOB_BYTES, 0);
  for (let i = failures; i < GATEWAY_COUNT; i++) buf[i >> 3] |= 1 << (i & 7);
  return buf;
}

function invert(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ~buf[i] & 0xff;
  return out;
}

function ctxFor(rates: number[], mapper?: (b: Buffer) => Buffer): DetectorContext {
  const observations = rates.map((rate, i) => {
    const raw = bitmapWithFailures(Math.round(rate * GATEWAY_COUNT));
    return observationRecord({
      observer: `Observer${String(i).padStart(2, '0')}`,
      gatewayResults: mapper ? mapper(raw) : raw,
    });
  });
  return {
    epoch: epochSnapshot(observations),
    epochs: [],
    gateways: new Map(),
    gatewaySnapshotAt: null,
    config: {
      similarityThreshold: 0.9,
      calibrated: false,
      calibrationId: null,
      coSubmissionWindowSeconds: 60,
      sharedAsnMinObservers: 4,
      persistentMinEpochs: 3,
      compositeMinKinds: 2,
      windowEpochs: 30,
      detectorVersion: 1,
    },
    now: 1_780_000_000_000,
    priorFindings: [],
  };
}

// The shape actually seen on mainnet epochs 513-515.
const MAINNET_SPLIT = [0.53, 0.54, 0.55, 0.55, 0.56, 0.71, 0.74, 0.76, 0.78, 0.82];

test('the mainnet two-population split is detected', () => {
  const findings = divergentAssessmentDetector.run(ctxFor(MAINNET_SPLIT));
  assert.equal(findings.length, 1);

  const d = findings[0].detail as unknown as SplitDetail;
  assert.equal(d.low.count, 5);
  assert.equal(d.high.count, 5);
  assert.ok(d.gap >= 0.12, `gap ${d.gap} should clear MIN_GAP`);
  assert.equal(findings[0].severity, 'medium');
});

test('inverting every bitmap yields an identical split — polarity cannot matter', () => {
  const normal = divergentAssessmentDetector.run(ctxFor(MAINNET_SPLIT));
  const flipped = divergentAssessmentDetector.run(ctxFor(MAINNET_SPLIT, invert));

  assert.equal(flipped.length, normal.length);
  const a = normal[0].detail as unknown as SplitDetail;
  const b = flipped[0].detail as unknown as SplitDetail;

  assert.equal(b.gap, a.gap, 'the gap is invariant under inversion');
  assert.equal(b.low.count, a.high.count, 'the groups swap sides but keep their sizes');
  assert.equal(b.high.count, a.low.count);
  assert.deepEqual(
    [...(b.low.observers as string[])].sort(),
    [...(a.high.observers as string[])].sort(),
    'membership is preserved, only the label flips',
  );
});

test('a single continuous population does not fire', () => {
  const spread = [0.53, 0.55, 0.57, 0.59, 0.61, 0.63, 0.65, 0.67];
  assert.deepEqual(divergentAssessmentDetector.run(ctxFor(spread)), []);
});

test('one lone outlier does not manufacture a split', () => {
  // A wide gap exists, but only 1 observer sits above it.
  const outlier = [0.53, 0.54, 0.55, 0.55, 0.56, 0.57, 0.95];
  assert.deepEqual(divergentAssessmentDetector.run(ctxFor(outlier)), []);
});

test('too few observers to form two populations does not fire', () => {
  assert.deepEqual(divergentAssessmentDetector.run(ctxFor([0.53, 0.55, 0.80, 0.82])), []);
});

test('a very wide split is escalated to high severity', () => {
  const wide = [0.20, 0.21, 0.22, 0.80, 0.81, 0.82];
  const findings = divergentAssessmentDetector.run(ctxFor(wide));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
});

test('both populations are named — the finding is the disagreement', () => {
  const findings = divergentAssessmentDetector.run(ctxFor(MAINNET_SPLIT));
  const d = findings[0].detail as unknown as SplitDetail;
  const named = new Set([...(d.low.observers as string[]), ...(d.high.observers as string[])]);
  assert.equal(named.size, MAINNET_SPLIT.length, 'every observer appears in exactly one group');
  assert.equal(
    findings[0].observers.length,
    MAINNET_SPLIT.length,
    'the finding implicates both sides, not just the outliers',
  );
});

test('mixed registry sizes are refused rather than compared', () => {
  const ctx = ctxFor(MAINNET_SPLIT);
  // One observer measured a different-sized registry: densities are not
  // comparable, so no conclusion is available.
  ctx.epoch.observations[0] = observationRecord({
    observer: 'OddOne',
    gatewayResults: bitmapWithFailures(10),
    gatewayCount: GATEWAY_COUNT - 40,
  });
  assert.deepEqual(divergentAssessmentDetector.run(ctx), []);
});
