/**
 * Detector #9 — observers inside one analyzer cluster.
 *
 * This reuses `detectClusters()` wholesale: it is a `Map<wallet, clusterKey>`
 * lookup and nothing more. No clustering logic is reimplemented anywhere in
 * this capability.
 *
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding, GatewayFacts } from '../types.js';
import { groupBy, makeFinding } from '../finding.js';

export const clusterOverlapDetector: Detector = {
  kind: 'analyzer_cluster_overlap',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const clustered: GatewayFacts[] = [];
    for (const observation of ctx.epoch.observations) {
      const gateway = ctx.gateways.get(observation.observer);
      if (gateway?.clusterKey) clustered.push(gateway);
    }

    const findings: Finding[] = [];
    for (const [key, group] of groupBy(clustered, (g) => g.clusterKey as string)) {
      if (group.length < 2) continue;

      const kind = group[0].clusterKind;
      findings.push(
        makeFinding({
          kind: 'analyzer_cluster_overlap',
          epochIndex: ctx.epoch.epochIndex,
          observers: group.map((g) => g.wallet),
          severity: kind === 'ip-exact' ? 'high' : 'medium',
          confidence: 0.85,
          summary:
            `${group.length} observers in epoch ${ctx.epoch.epochIndex} belong to the same ` +
            `centralization cluster (${key}).`,
          detail: {
            clusterKey: key,
            clusterKind: kind,
            clusterSize: group[0].clusterSize,
            observerCount: group.length,
            fqdns: group.map((g) => g.fqdn),
            totalStake: group.reduce((sum, g) => sum + g.stake, 0),
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
