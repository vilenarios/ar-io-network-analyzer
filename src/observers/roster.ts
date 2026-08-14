/**
 * The one place the published gateway roster is turned into `GatewayFacts`.
 *
 * Both the findings cadence and the calibration command need it, and both used
 * to carry their own copy of the same twelve-field mapping — so a field added
 * to `GatewayFacts` would silently be missing from calibration only, which is
 * precisely the kind of divergence nothing would ever notice.
 *
 * This module NEVER resolves DNS or geo-locates anything. It reads the file the
 * daily analysis already published; a missing or stale file degrades the
 * infrastructure detectors, it does not license a lookup.
 */

import { readPublishedDocument } from '../publish/publish.js';
import type { GatewaysDocument } from '../publish/contract.js';
import type { GatewayFacts } from './types.js';

const DEFAULT_ANALYSIS_MAX_AGE_SECONDS = 172_800; // 48h

export interface GatewayRoster {
  gateways: Map<string, GatewayFacts>;
  /** ISO timestamp of the roster the facts came from; null when absent. */
  snapshotAt: string | null;
  /** Missing or older than ANALYSIS_MAX_AGE_SECONDS. */
  degraded: boolean;
  ageSeconds: number | null;
}

function maxAgeSeconds(): number {
  const raw = Number(process.env.ANALYSIS_MAX_AGE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ANALYSIS_MAX_AGE_SECONDS;
}

/** Project one published roster entry into the facts detectors may read. */
export function toGatewayFacts(entry: GatewaysDocument['gateways'][number]): GatewayFacts {
  return {
    wallet: entry.wallet,
    fqdn: entry.fqdn,
    ipAddress: entry.ipAddress,
    ipRange: entry.ipRange,
    asn: entry.asn,
    asnOrg: entry.asnOrg,
    baseDomain: entry.baseDomain,
    clusterKey: entry.clusterKey,
    clusterKind: entry.clusterKind,
    clusterSize: entry.clusterSize,
    stake: entry.stake,
    overallCentralization: entry.scores.overall,
  };
}

/**
 * Load the roster from the published `gateways.json`.
 *
 * `quiet` suppresses the warnings for callers that report the same condition
 * themselves (the calibration command explains the bias in its own words).
 */
export function loadGatewayRoster(options: { quiet?: boolean } = {}): GatewayRoster {
  const document = readPublishedDocument<GatewaysDocument>('api/v1/gateways.json');

  if (!document) {
    if (!options.quiet) {
      console.warn('⚠️  no published gateways.json — infrastructure detectors run degraded');
    }
    return { gateways: new Map(), snapshotAt: null, degraded: true, ageSeconds: null };
  }

  const ageSeconds = (Date.now() - Date.parse(document.generatedAt)) / 1000;
  const degraded = !Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds();

  if (degraded && !options.quiet) {
    console.warn(
      `⚠️  gateways.json is ${Math.round(ageSeconds / 3600)}h old — infrastructure detectors run degraded`
    );
  }

  const gateways = new Map<string, GatewayFacts>();
  for (const entry of document.gateways) {
    gateways.set(entry.wallet, toGatewayFacts(entry));
  }

  return {
    gateways,
    snapshotAt: document.generatedAt,
    degraded,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
  };
}
