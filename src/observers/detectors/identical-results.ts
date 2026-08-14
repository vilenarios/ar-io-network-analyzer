/**
 * Detector #2 — byte-identical result blobs.
 *
 * Groups by sha256 of the *masked* prefix: the first `ceil(gatewayCount/8)`
 * bytes with the trailing partial byte bit-masked. Unmasked, the constant zero
 * padding would make every pair look far more alike than it is.
 *
 * Touches the blob only as bytes; `gatewayCount` is a decoded scalar, not the
 * bitmap encoding. Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { groupBy, makeFinding } from '../finding.js';
import { maskedDigest, meaningfulBytes } from '../hamming.js';

export const identicalResultsDetector: Detector = {
  kind: 'identical_results',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const { epoch } = ctx;
    const groups = groupBy(epoch.observations, (o) =>
      maskedDigest(o.gatewayResults, o.gatewayCount)
    );
    const findings: Finding[] = [];

    for (const [digest, observations] of groups) {
      if (observations.length < 2) continue;

      const gatewayCounts = [...new Set(observations.map((o) => o.gatewayCount))];

      // Zero comparable bytes is not "identical", it is "no evidence". Decode
      // already refuses an out-of-range gatewayCount, so this is defence in
      // depth for rows written before that guard existed: without it every
      // such blob hashes to the digest of an empty buffer and this detector —
      // the one that emits severity `high` at confidence 1.0 — groups them all.
      const comparedBytes = meaningfulBytes(Math.min(...gatewayCounts));
      if (comparedBytes === 0) continue;

      findings.push(
        makeFinding({
          kind: 'identical_results',
          epochIndex: epoch.epochIndex,
          observers: observations.map((o) => o.observer),
          severity: 'high',
          confidence: 1.0,
          summary:
            `${observations.length} observers reported byte-identical gateway results ` +
            `in epoch ${epoch.epochIndex}.`,
          detail: {
            maskedDigest: digest,
            observerCount: observations.length,
            gatewayCount: gatewayCounts.length === 1 ? gatewayCounts[0] : gatewayCounts,
            meaningfulBytes: comparedBytes,
            blobBytes: observations[0].gatewayResults.length,
            reportTxIds: [...new Set(observations.map((o) => o.reportTxId))],
            submittedAtUnix: observations.map((o) => o.submittedAt).sort((a, b) => a - b),
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
