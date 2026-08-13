/**
 * Detector #4 — three or more observers submitting inside one short window.
 *
 * Weak on its own (an epoch boundary makes everyone submit at once), so it is
 * `low` / 0.4 and exists mainly to feed the composite rollup. Groups that are
 * already a single analyzer cluster are skipped rather than restated.
 *
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { makeFinding } from '../finding.js';

export const coSubmissionTimingDetector: Detector = {
  kind: 'co_submission_timing',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const { epoch, config, gateways } = ctx;
    const windowSeconds = config.coSubmissionWindowSeconds;

    const sorted = [...epoch.observations].sort((a, b) => a.submittedAt - b.submittedAt);
    const findings: Finding[] = [];
    const emitted = new Set<string>();

    for (let start = 0; start < sorted.length; start++) {
      let end = start;
      while (
        end + 1 < sorted.length &&
        sorted[end + 1].submittedAt - sorted[start].submittedAt <= windowSeconds
      ) {
        end++;
      }

      const window = sorted.slice(start, end + 1);
      if (window.length < 3) continue;

      const observers = window.map((o) => o.observer).sort();
      const key = observers.join(',');
      if (emitted.has(key)) continue;

      // A window that is exactly one known cluster adds nothing new.
      const clusterKeys = observers.map((observer) => gateways.get(observer)?.clusterKey ?? null);
      if (clusterKeys.every((k) => k !== null && k === clusterKeys[0])) continue;

      emitted.add(key);
      const submittedAtUnix = window.map((o) => o.submittedAt);

      findings.push(
        makeFinding({
          kind: 'co_submission_timing',
          epochIndex: epoch.epochIndex,
          observers,
          severity: 'low',
          confidence: 0.4,
          summary:
            `${observers.length} observers submitted within ${windowSeconds}s of each other ` +
            `in epoch ${epoch.epochIndex}.`,
          detail: {
            windowSeconds,
            submittedAtUnix,
            spreadSeconds: submittedAtUnix[submittedAtUnix.length - 1] - submittedAtUnix[0],
            epochObservationCount: epoch.observations.length,
          },
          now: ctx.now,
        })
      );

      // Advance past this window's members to avoid emitting every subset.
      start = end;
    }

    return findings;
  },
};
