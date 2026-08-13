/**
 * Detector #12 — the same observer set flagged epoch after epoch.
 *
 * A single epoch is an anecdote; the same set correlating across three or more
 * separate 24h epochs is a pattern. Cross-epoch, so `epochIndex` is null.
 *
 * Runs last and consumes every earlier finding in the window.
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding } from '../types.js';
import { escalate, groupBy, makeFinding, maxSeverity } from '../finding.js';

export const persistentDetector: Detector = {
  kind: 'persistent_correlation',
  requiresDecodedResults: false,
  scope: 'window',

  run(ctx: DetectorContext): Finding[] {
    const contributors = ctx.priorFindings.filter(
      (finding) => finding.epochIndex !== null && finding.observers.length >= 2
    );
    if (contributors.length === 0) return [];

    const findings: Finding[] = [];

    for (const [, group] of groupBy(contributors, (f) => f.id.split(':')[2])) {
      const epochIndexes = [...new Set(group.map((f) => f.epochIndex as number))].sort(
        (a, b) => a - b
      );
      if (epochIndexes.length < ctx.config.persistentMinEpochs) continue;

      const contributingSeverity = maxSeverity(group.map((f) => f.severity));
      const observers = group[0].observers;

      findings.push(
        makeFinding({
          kind: 'persistent_correlation',
          epochIndex: null,
          observers,
          severity: escalate(contributingSeverity),
          confidence: 0.9,
          summary:
            `${observers.length} observers were flagged together in ${epochIndexes.length} ` +
            `distinct epochs (${epochIndexes[0]}–${epochIndexes[epochIndexes.length - 1]}).`,
          detail: {
            epochIndexes,
            epochCount: epochIndexes.length,
            kinds: [...new Set(group.map((f) => f.kind))],
            firstEpochIndex: epochIndexes[0],
            lastEpochIndex: epochIndexes[epochIndexes.length - 1],
            maxContributingSeverity: contributingSeverity,
            contributingFindingIds: group.map((f) => f.id),
            windowEpochs: ctx.epochs.length,
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
