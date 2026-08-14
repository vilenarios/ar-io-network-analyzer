/**
 * Detector #1 — two or more observers pointing at the same report transaction.
 *
 * The strongest available signal and the cheapest: `reportTxId` is an exact
 * identity, so confidence is 1.0 with no inference. Epoch 511 had seven
 * observers sharing a single report.
 *
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { groupBy, makeFinding } from '../finding.js';

export const sharedReportTxDetector: Detector = {
  kind: 'shared_report_tx',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const { epoch } = ctx;
    const groups = groupBy(epoch.observations, (o) => o.reportTxId);
    const findings: Finding[] = [];

    for (const [reportTxId, observations] of groups) {
      if (observations.length < 2) continue;

      const submittedAtUnix = observations.map((o) => o.submittedAt).sort((a, b) => a - b);
      const spread = submittedAtUnix[submittedAtUnix.length - 1] - submittedAtUnix[0];

      findings.push(
        makeFinding({
          kind: 'shared_report_tx',
          epochIndex: epoch.epochIndex,
          observers: observations.map((o) => o.observer),
          severity: observations.length >= 3 ? 'high' : 'medium',
          confidence: 1.0,
          summary:
            `${observations.length} observers submitted the same report transaction ` +
            `${reportTxId} in epoch ${epoch.epochIndex}.`,
          detail: {
            reportTxId,
            observerCount: observations.length,
            epochObservationCount: epoch.observations.length,
            epochDistinctReportTxIds: epoch.distinctReportTxIds,
            submittedAtUnix,
            submissionSpreadSeconds: spread,
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
