/**
 * Detectors #5–#8 — infrastructure joins.
 *
 * These are pure joins over the analyzer's already-published DNS and geo
 * output, keyed on `wallet === observer`. No DNS, no geo, no network calls:
 * putting a 640-FQDN resolve on a 10-minute cadence is exactly what the
 * degraded-mode rule exists to prevent.
 *
 * None of them decode the bitmap.
 */

import type { Detector, DetectorContext, Finding, GatewayFacts } from '../types.js';
import { groupBy, makeFinding } from '../finding.js';

/** Observers that appear in the published gateway roster. */
function observedGateways(ctx: DetectorContext): GatewayFacts[] {
  const facts: GatewayFacts[] = [];
  for (const observation of ctx.epoch.observations) {
    const gateway = ctx.gateways.get(observation.observer);
    if (gateway) facts.push(gateway);
  }
  return facts;
}

export const sharedIpDetector: Detector = {
  kind: 'shared_ip',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const withIp = observedGateways(ctx).filter((g) => g.ipAddress !== null);
    const findings: Finding[] = [];

    for (const [ipAddress, group] of groupBy(withIp, (g) => g.ipAddress as string)) {
      if (group.length < 2) continue;
      const distinctBaseDomains = [...new Set(group.map((g) => g.baseDomain))];

      findings.push(
        makeFinding({
          kind: 'shared_ip',
          epochIndex: ctx.epoch.epochIndex,
          observers: group.map((g) => g.wallet),
          severity: distinctBaseDomains.length >= 2 ? 'high' : 'medium',
          confidence: 0.95,
          summary:
            `${group.length} observers in epoch ${ctx.epoch.epochIndex} resolve to the same ` +
            `IP address ${ipAddress}.`,
          detail: {
            ipAddress,
            ipRange: group[0].ipRange,
            fqdns: group.map((g) => g.fqdn),
            distinctBaseDomains,
            asn: group[0].asn,
            isp: group[0].asnOrg,
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};

export const sharedIpRangeDetector: Detector = {
  kind: 'shared_ip_range',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const withRange = observedGateways(ctx).filter((g) => g.ipRange !== null);
    const findings: Finding[] = [];

    for (const [ipRange, group] of groupBy(withRange, (g) => g.ipRange as string)) {
      const distinctIps = [...new Set(group.map((g) => g.ipAddress).filter(Boolean))];
      // A /24 that is really one address is #5's finding, not this one.
      if (group.length < 3 || distinctIps.length < 2) continue;

      findings.push(
        makeFinding({
          kind: 'shared_ip_range',
          epochIndex: ctx.epoch.epochIndex,
          observers: group.map((g) => g.wallet),
          severity: 'medium',
          confidence: 0.7,
          summary:
            `${group.length} observers in epoch ${ctx.epoch.epochIndex} sit in the same ` +
            `/24 (${ipRange}) across ${distinctIps.length} addresses.`,
          detail: {
            ipRange,
            distinctIps,
            fqdns: group.map((g) => g.fqdn),
            distinctBaseDomains: [...new Set(group.map((g) => g.baseDomain))],
            asns: [...new Set(group.map((g) => g.asn).filter(Boolean))],
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};

export const sharedBaseDomainDetector: Detector = {
  kind: 'shared_base_domain',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const findings: Finding[] = [];

    for (const [baseDomain, group] of groupBy(observedGateways(ctx), (g) => g.baseDomain)) {
      if (!baseDomain || group.length < 2) continue;

      findings.push(
        makeFinding({
          kind: 'shared_base_domain',
          epochIndex: ctx.epoch.epochIndex,
          observers: group.map((g) => g.wallet),
          severity: 'medium',
          confidence: 0.9,
          summary:
            `${group.length} observers in epoch ${ctx.epoch.epochIndex} run under the same ` +
            `registrable domain ${baseDomain}.`,
          detail: {
            baseDomain,
            fqdns: group.map((g) => g.fqdn),
            distinctIps: [...new Set(group.map((g) => g.ipAddress).filter(Boolean))],
            distinctAsns: [...new Set(group.map((g) => g.asn).filter(Boolean))],
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};

export const sharedAsnDetector: Detector = {
  kind: 'shared_asn',
  requiresDecodedResults: false,
  scope: 'epoch',

  run(ctx: DetectorContext): Finding[] {
    const withAsn = observedGateways(ctx).filter((g) => g.asn !== null);
    const findings: Finding[] = [];

    // Network-wide share, so a large legitimate host reads as `info`.
    const networkTotal = [...ctx.gateways.values()].filter((g) => g.asn !== null).length;
    const networkByAsn = groupBy(
      [...ctx.gateways.values()].filter((g) => g.asn !== null),
      (g) => g.asn as string
    );

    for (const [asn, group] of groupBy(withAsn, (g) => g.asn as string)) {
      if (group.length < ctx.config.sharedAsnMinObservers) continue;

      const networkShare =
        networkTotal > 0 ? ((networkByAsn.get(asn)?.length ?? 0) / networkTotal) * 100 : 0;
      const isMajorHost = networkShare > 10;

      findings.push(
        makeFinding({
          kind: 'shared_asn',
          epochIndex: ctx.epoch.epochIndex,
          observers: group.map((g) => g.wallet),
          severity: isMajorHost ? 'info' : 'low',
          confidence: 0.5,
          summary:
            `${group.length} observers in epoch ${ctx.epoch.epochIndex} are hosted on ${asn}` +
            `${isMajorHost ? ` (a major host: ${networkShare.toFixed(1)}% of the network)` : ''}.`,
          detail: {
            asn,
            asnOrg: group[0].asnOrg,
            observerCount: group.length,
            networkAsnGatewayCount: networkByAsn.get(asn)?.length ?? 0,
            networkSharePercentage: Number(networkShare.toFixed(2)),
            fqdns: group.map((g) => g.fqdn),
          },
          now: ctx.now,
        })
      );
    }

    return findings;
  },
};
