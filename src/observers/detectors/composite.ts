/**
 * Detector #11 — composite independence risk.
 *
 * Corroboration across *evidence families*, not across kinds: two network
 * findings (same IP and same base domain) are one fact stated twice, and must
 * not compose into higher confidence. Only findings from different families
 * covering the identical observer set count.
 *
 * Runs after #1–#9 and consumes their output via `ctx.priorFindings`.
 * Does not decode the bitmap.
 */

import type { Detector, DetectorContext, Finding, FindingKind } from '../types.js';
import { groupBy, makeFinding, maxSeverity } from '../finding.js';

type Family = 'report' | 'results' | 'network' | 'timing';

const FAMILY_BY_KIND: Partial<Record<FindingKind, Family>> = {
  shared_report_tx: 'report',
  identical_results: 'results',
  near_identical_results: 'results',
  shared_ip: 'network',
  shared_ip_range: 'network',
  shared_base_domain: 'network',
  shared_asn: 'network',
  analyzer_cluster_overlap: 'network',
  co_submission_timing: 'timing',
  // divergent_assessment is deliberately ABSENT. Every family above is
  // evidence that observers may be the SAME actor; composite correlates them
  // into an independence risk. Divergence is the opposite signal — observers
  // that disagree by 20 points are demonstrably not one another — so folding
  // it in here would raise an independence score using evidence of
  // independence. It is a measurement-quality finding, not a collusion one.
};

export const compositeDetector: Detector = {
  kind: 'composite_independence_risk',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const contributors = ctx.priorFindings.filter(
      (finding) =>
        finding.epochIndex === ctx.epoch.epochIndex && FAMILY_BY_KIND[finding.kind] !== undefined
    );
    if (contributors.length === 0) return [];

    const findings: Finding[] = [];

    // The observer-set hash is the third id segment — identical sets collide
    // by construction, which is exactly the grouping we want.
    for (const [, group] of groupBy(contributors, (f) => f.id.split(':')[2])) {
      const families = new Map<Family, Finding[]>();
      for (const finding of group) {
        const family = FAMILY_BY_KIND[finding.kind] as Family;
        families.set(family, [...(families.get(family) ?? []), finding]);
      }

      if (families.size < ctx.config.compositeMinKinds) continue;

      // One confidence per family — the strongest member of each.
      const familyConfidences = [...families.values()].map((members) =>
        Math.max(...members.map((m) => m.confidence))
      );
      const confidence = Math.min(
        0.99,
        1 - familyConfidences.reduce((product, c) => product * (1 - c), 1)
      );

      const hasStrongContributor = group.some((finding) => finding.confidence >= 0.9);
      const severity = families.size >= 2 && hasStrongContributor ? 'high' : 'medium';

      const observers = group[0].observers;
      findings.push(
        makeFinding({
          kind: 'composite_independence_risk',
          epochIndex: ctx.epoch.epochIndex,
          observers,
          severity,
          confidence,
          summary:
            `${observers.length} observers in epoch ${ctx.epoch.epochIndex} are correlated across ` +
            `${families.size} independent evidence families ` +
            `(${[...families.keys()].join(', ')}).`,
          detail: {
            contributingFindingIds: group.map((f) => f.id),
            kinds: [...new Set(group.map((f) => f.kind))],
            families: [...families.keys()],
            maxContributingSeverity: maxSeverity(group.map((f) => f.severity)),
            observerCount: observers.length,
            epochObservationCount: ctx.epoch.observations.length,
            observationSharePercentage: Number(
              ((observers.length / Math.max(1, ctx.epoch.observations.length)) * 100).toFixed(2)
            ),
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
