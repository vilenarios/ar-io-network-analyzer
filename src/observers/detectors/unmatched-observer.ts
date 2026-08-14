/**
 * Detector #10 — an observer on chain with no entry in the gateway roster.
 *
 * Informational: the gateway may have left the network, failed DNS, or the
 * roster may simply be older than the observation. It is emitted so that the
 * gap is visible rather than silently reducing the denominator of every
 * infrastructure join.
 *
 * Skipped entirely when no roster is loaded at all — with an empty map every
 * observer is trivially "unmatched", which is noise, not a finding.
 *
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { makeFinding } from '../finding.js';

export const unmatchedObserverDetector: Detector = {
  kind: 'unmatched_observer',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    if (ctx.gateways.size === 0) return [];

    const findings: Finding[] = [];
    for (const observation of ctx.epoch.observations) {
      if (ctx.gateways.has(observation.observer)) continue;

      findings.push(
        makeFinding({
          kind: 'unmatched_observer',
          epochIndex: ctx.epoch.epochIndex,
          observers: [observation.observer],
          severity: 'info',
          confidence: 1.0,
          summary:
            `Observer ${observation.observer} submitted in epoch ${ctx.epoch.epochIndex} but is ` +
            `absent from the published gateway roster.`,
          detail: {
            observer: observation.observer,
            reportTxId: observation.reportTxId,
            submittedAtUnix: observation.submittedAt,
            gatewaySnapshotAt: ctx.gatewaySnapshotAt,
            rosterSize: ctx.gateways.size,
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
