/**
 * Detector #13 — observers splitting into distinct assessment populations.
 *
 * Every other detector asks whether observers are too ALIKE. This one asks the
 * opposite: are they too DIFFERENT, in a way that suggests they are not all
 * measuring the same thing?
 *
 * Each observer's bitmap carries one bit per gateway. Its density — the share
 * of gateways it marked one way — is a single number summarising that
 * observer's verdict on the whole registry. Observers assessing the same 643
 * gateways over the same 24 hours should land in a continuous spread around
 * some network-wide truth. A CLEAN GAP between two tight groups does not
 * describe a network; it describes two different measuring instruments.
 *
 * Observed on mainnet, epochs 510–516: one population sat at 53–56% and
 * another at 69–83%, with a persistent ~20-point gap and no one in between.
 * Three observers stepped across it mid-series (55/53/53 → 76/70/71) while
 * others held station on both sides, which is a rollout signature — a version
 * or config change propagating — not gateways degrading. A pure degradation
 * story cannot explain why the low group never moved.
 *
 * This matters for centralization specifically: observers that agree because
 * they run identical software are not independent witnesses, and observers
 * that disagree by 20 points cannot all be right. Either way the observation
 * layer is weaker than its headcount suggests.
 *
 * This is the first detector to interpret bitmap CONTENT rather than compare
 * bytes, hence `requiresDecodedResults: true`.
 *
 * POLARITY: the finding is invariant under bit inversion — inverting every
 * bitmap maps density d to 1-d, which preserves both the gap and the
 * membership split. So this never needs to know which bit means "failed". The
 * reported densities follow the convention validated against mainnet epoch
 * 514, where the summed CLEAR bits (10,979) exactly equalled the Epoch
 * account's own `failureCounts` total, making a clear bit a failure.
 */

import type { Detector, DetectorContext, Finding, ObservationRecord } from '../types.js';
import { makeFinding } from '../finding.js';

/**
 * Minimum separation between the two groups, in density points.
 *
 * A heuristic, not a calibrated value. The mainnet split ran ~15–20 points;
 * 0.12 sits below that with room to spare while staying far above the ~1–3
 * point jitter seen WITHIN each group. Unlike `similarityThreshold` this is
 * not comparing near-identical blobs, so it does not depend on the
 * calibration run.
 */
const MIN_GAP = 0.12;

/**
 * Both sides must have this many observers. Two is not a population — a single
 * outlier pairing with another would fire on ordinary spread.
 */
const MIN_CLUSTER = 3;

/** Share of the meaningful bitmap prefix whose bits are CLEAR. */
function clearBitDensity(observation: ObservationRecord): number | null {
  const bits = observation.gatewayCount;
  if (!Number.isInteger(bits) || bits <= 0) return null;
  if (observation.gatewayResults.length * 8 < bits) return null;

  let set = 0;
  for (let i = 0; i < bits; i++) {
    if (observation.gatewayResults[i >> 3] & (1 << (i & 7))) set++;
  }
  return (bits - set) / bits;
}

export const divergentAssessmentDetector: Detector = {
  kind: 'divergent_assessment',
  requiresDecodedResults: true,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const { epoch } = ctx;

    // A mixed registry size would make densities incomparable — a bitmap over
    // 600 gateways and one over 643 are not the same measurement.
    const counts = new Set(epoch.observations.map((o) => o.gatewayCount));
    if (counts.size > 1) return [];

    const scored: { observer: string; density: number }[] = [];
    for (const observation of epoch.observations) {
      const density = clearBitDensity(observation);
      if (density !== null) scored.push({ observer: observation.observer, density });
    }
    if (scored.length < MIN_CLUSTER * 2) return [];

    scored.sort((a, b) => a.density - b.density);

    // Widest gap that still leaves MIN_CLUSTER observers on each side.
    let splitAt = -1;
    let widest = 0;
    for (let i = MIN_CLUSTER - 1; i <= scored.length - MIN_CLUSTER - 1; i++) {
      const gap = scored[i + 1].density - scored[i].density;
      if (gap > widest) {
        widest = gap;
        splitAt = i;
      }
    }
    if (splitAt < 0 || widest < MIN_GAP) return [];

    const low = scored.slice(0, splitAt + 1);
    const high = scored.slice(splitAt + 1);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

    const lowDensities = low.map((s) => s.density);
    const highDensities = high.map((s) => s.density);

    // A gap several times wider than the within-group spread is what separates
    // "two instruments" from "one noisy population".
    const widestWithin = Math.max(spread(lowDensities), spread(highDensities));
    const ratio = widestWithin > 0 ? widest / widestWithin : Infinity;

    return [
      makeFinding({
        kind: 'divergent_assessment',
        epochIndex: epoch.epochIndex,
        // Both groups are implicated: the finding is the disagreement, and
        // nothing here says which side is correct.
        observers: scored.map((s) => s.observer),
        severity: widest >= 0.2 ? 'high' : 'medium',
        // The split is arithmetic, but calling it non-independence is
        // inference — a real network event could in principle do this.
        confidence: 0.7,
        summary:
          `${scored.length} observers split into two assessment populations in epoch ` +
          `${epoch.epochIndex}: ${low.length} at ${(100 * mean(lowDensities)).toFixed(0)}% and ` +
          `${high.length} at ${(100 * mean(highDensities)).toFixed(0)}%, separated by a clean ` +
          `${(100 * widest).toFixed(0)}-point gap with no observer in between. Observers ` +
          `assessing the same ${counts.values().next().value} gateways should not fall into ` +
          `disjoint groups; this looks like differing software or configuration rather than ` +
          `differing gateways.`,
        detail: {
          gatewayCount: counts.values().next().value,
          observerCount: scored.length,
          gap: Number(widest.toFixed(4)),
          gapToWithinGroupSpreadRatio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
          low: {
            count: low.length,
            meanDensity: Number(mean(lowDensities).toFixed(4)),
            spread: Number(spread(lowDensities).toFixed(4)),
            observers: low.map((s) => s.observer),
          },
          high: {
            count: high.length,
            meanDensity: Number(mean(highDensities).toFixed(4)),
            spread: Number(spread(highDensities).toFixed(4)),
            observers: high.map((s) => s.observer),
          },
          densityConvention: 'share of bitmap bits CLEAR; clear === gateway failed',
          minGap: MIN_GAP,
          minCluster: MIN_CLUSTER,
        },
        now: ctx.now,
      }),
    ];
  },
};
