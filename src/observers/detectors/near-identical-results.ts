/**
 * Detector #3 — near-identical result blobs (masked Hamming).
 *
 * This is the detector the epoch-511 cluster motivated: its seven suspicious
 * blobs were all *distinct*, so equality finds nothing there.
 *
 * The threshold is an UNCALIBRATED placeholder. Until a calibration row is
 * active, every finding carries `calibrated: false`, confidence is capped at
 * 0.5 and severity at `medium` — shipping `high` off an unvalidated constant
 * would manufacture false confidence. See §5 of the spec and
 * `yarn observers:calibrate`.
 *
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { makeFinding } from '../finding.js';
import { connectedComponents, maskedDigest, pairwiseMatrix } from '../hamming.js';

export const nearIdenticalResultsDetector: Detector = {
  kind: 'near_identical_results',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const { epoch, config } = ctx;
    if (epoch.observations.length < 2) return [];

    const digests = new Map(
      epoch.observations.map((o) => [o.observer, maskedDigest(o.gatewayResults, o.gatewayCount)])
    );

    const pairs = pairwiseMatrix(epoch.observations).filter(
      (pair) =>
        pair.result.similarity >= config.similarityThreshold &&
        // Pairs already covered by #2 (identical_results) are excluded.
        digests.get(pair.a.observer) !== digests.get(pair.b.observer)
    );

    if (pairs.length === 0) return [];

    const observers = epoch.observations.map((o) => o.observer);
    const components = connectedComponents(
      observers,
      pairs.map((pair) => [pair.a.observer, pair.b.observer] as [string, string])
    );

    const findings: Finding[] = [];
    for (const component of components) {
      const members = new Set(component);
      const componentPairs = pairs.filter(
        (pair) => members.has(pair.a.observer) && members.has(pair.b.observer)
      );
      if (componentPairs.length === 0) continue;

      const similarities = componentPairs.map((p) => p.result.similarity);
      const hammingBits = componentPairs.map((p) => p.result.hammingBits);
      const minSimilarity = Math.min(...similarities);
      const maxSimilarity = Math.max(...similarities);
      const observations = epoch.observations.filter((o) => members.has(o.observer));

      // Calibrated: full strength. Uncalibrated: capped, and the data says so.
      const severity = config.calibrated
        ? minSimilarity >= config.similarityThreshold + 0.03
          ? 'high'
          : 'medium'
        : 'medium';
      const confidence = config.calibrated ? 0.9 : 0.5;

      findings.push(
        makeFinding({
          kind: 'near_identical_results',
          epochIndex: epoch.epochIndex,
          observers: component,
          severity,
          confidence,
          summary:
            `${component.length} observers reported near-identical gateway results ` +
            `(${(minSimilarity * 100).toFixed(1)}–${(maxSimilarity * 100).toFixed(1)}% similar) ` +
            `in epoch ${epoch.epochIndex}${config.calibrated ? '' : '; threshold uncalibrated'}.`,
          detail: {
            blobBytes: observations[0].gatewayResults.length,
            meaningfulBytes: componentPairs[0].result.meaningfulBytes,
            gatewayCount: componentPairs[0].result.comparedBits,
            gatewayCountMismatch: componentPairs.some((p) => p.result.gatewayCountMismatch),
            thresholdSimilarity: config.similarityThreshold,
            thresholdProvenance: config.calibrated ? 'calibrated' : 'uncalibrated-default',
            calibrated: config.calibrated,
            calibrationId: config.calibrationId,
            minSimilarity,
            maxSimilarity,
            minHammingBits: Math.min(...hammingBits),
            maxHammingBits: Math.max(...hammingBits),
            allBlobsDistinct:
              new Set(observations.map((o) => digests.get(o.observer))).size ===
              observations.length,
            pairs: componentPairs.map((pair) => ({
              a: pair.a.observer,
              b: pair.b.observer,
              similarity: pair.result.similarity,
              hammingBits: pair.result.hammingBits,
              hammingBytes: pair.result.hammingBytes,
            })),
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
