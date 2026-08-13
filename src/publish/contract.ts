/**
 * The published JSON contract (v1).
 *
 * Every document is a pure projection of data that already exists — no
 * document builder here performs I/O, and none of them re-derive analysis.
 * The portal reads these files directly; the server never queries.
 *
 * Sentinels never cross this boundary: `resolution_failed` / `unknown` become
 * `null` plus an explicit `dnsResolved` flag.
 */

import type {
  CentralizationReport,
  ClusterSummary,
  GatewayAnalysis,
  InfrastructureImpact,
} from '../types.js';
import { DNS_FAILURE_SENTINEL, IP_RANGE_UNKNOWN_SENTINEL } from '../utils/dns.js';
import type {
  Finding,
  GatewayObserverSummary,
  ObserverIndependenceRollup,
  Severity,
} from '../observers/types.js';

export const SCHEMA_VERSION = '1.0';

/** The bitmap encoding published documents advertise but never interpret. */
export const GATEWAY_RESULTS_ENCODING = 'gar-bitmap-v1-lsb';

export interface DocumentEntry {
  path: string;
  sha256: string;
  bytes: number;
  generatedAt: string;
}

export interface Manifest {
  schemaVersion: string;
  generatedAt: string;
  documents: {
    network?: DocumentEntry;
    gateways?: DocumentEntry;
    observers?: DocumentEntry;
    findings?: DocumentEntry;
    epochs?: Array<DocumentEntry & { epochIndex: number }>;
  };
  freshness: {
    analysisGeneratedAt: string | null;
    analysisAgeSeconds: number | null;
    analysisStale: boolean;
    findingsGeneratedAt: string | null;
    captureLastRunAt: string | null;
    captureAgeSeconds: number | null;
    captureStale: boolean;
    captureLastStatus: string | null;
    captureConsecutiveFailures: number | null;
  };
  archive: Array<{ date: string; path: string }>;
}

export interface NetworkDocument {
  schemaVersion: string;
  generatedAt: string;
  totals: {
    gatewaysAnalyzed: number;
    gatewaysInNetwork: number;
    resolved: number;
    failedDns: number;
    clustered: number;
    highCentralization: number;
  };
  clusters: Array<{
    id: string;
    key: string;
    size: number;
    avgScore: number;
    baseDomain: string;
    pattern: string;
    gateways: string[];
    wallets: string[];
    totalRewards: number | null;
  }>;
  topSuspicious: Array<{ fqdn: string; score: number; reasons: string[] }>;
  infrastructure: InfrastructureImpact | null;
  economics: CentralizationReport['economicImpact'] | null;
  versions: CentralizationReport['versionStats'] | null;
  observers: ObserverIndependenceRollup | null;
}

export interface GatewayDocumentEntry {
  wallet: string;
  fqdn: string;
  stake: number;
  status: string;
  baseDomain: string;
  domainPattern: string;
  domainGroupSize: number;
  dnsResolved: boolean;
  ipAddress: string | null;
  ipRange: string | null;
  asn: string | null;
  asnOrg: string | null;
  isp: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  hosting: boolean | null;
  arIoVersion: string | null;
  arIoRelease: string | null;
  clusterId: string | null;
  clusterKey: string | null;
  clusterKind: 'domain' | 'ip-exact' | null;
  clusterSize: number;
  clusterRole: string;
  suspicionNotes: string[];
  scores: {
    domain: number;
    network: number;
    stake: number;
    temporal: number;
    technical: number;
    geographic: number;
    overall: number;
  };
  observer: GatewayObserverSummary | null;
}

export interface GatewaysDocument {
  schemaVersion: string;
  generatedAt: string;
  count: number;
  gateways: GatewayDocumentEntry[];
}

export interface ObserversDocument {
  schemaVersion: string;
  generatedAt: string;
  epochRange: { from: number; to: number; count: number } | null;
  observerCount: number;
  observers: Array<{
    observer: string;
    fqdn: string | null;
    epochsObserved: number;
    firstEpochIndex: number | null;
    lastEpochIndex: number | null;
    distinctReportTxIds: number;
    sharedReportEpochs: number;
    findingCount: number;
    maxSeverity: Severity | null;
    kinds: string[];
  }>;
  epochs: Array<{
    epochIndex: number;
    observationCount: number;
    distinctReportTxIds: number;
    registryCaptured: boolean;
    findingCount: number;
    firstSubmittedAtUnix: number;
    lastSubmittedAtUnix: number;
  }>;
}

export interface EpochDocument {
  schemaVersion: string;
  generatedAt: string;
  epochIndex: number;
  observationCount: number;
  distinctReportTxIds: number;
  registryCaptured: boolean;
  registryDigest: string | null;
  firstSubmittedAtUnix: number;
  lastSubmittedAtUnix: number;
  observations: Array<{
    observer: string;
    pubkey: string;
    reportTxId: string;
    submittedAtUnix: number;
    submittedAt: string | null;
    suspectTimestamp: boolean;
    gatewayCount: number;
    gatewayResultsBase64: string;
    gatewayResultsMeaningfulBytes: number;
    gatewayResultsEncoding: string;
    accountBytes: number;
    schemaVersion: string | null;
    revision: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  findings: PublishedFinding[];
}

export interface PublishedFinding {
  id: string;
  kind: string;
  epochIndex: number | null;
  observers: string[];
  observerCount: number;
  severity: Severity;
  confidence: number;
  detectedAt: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface FindingsDocument {
  schemaVersion: string;
  generatedAt: string;
  detectorVersion: number;
  calibrated: boolean;
  calibrationId: number | null;
  thresholdSimilarity: number;
  epochRange: { from: number; to: number; count: number } | null;
  counts: {
    total: number;
    bySeverity: Record<Severity, number>;
    byKind: Record<string, number>;
  };
  findings: PublishedFinding[];
}

/** ISO-8601 Z rendering of a unix-ms or unix-seconds instant. */
export function dateToIso(
  value: number | null | undefined,
  unit: 'ms' | 's' = 'ms'
): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const ms = unit === 's' ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Analyzer sentinels never leave the process. */
export function normalizeSentinels(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === DNS_FAILURE_SENTINEL || value === IP_RANGE_UNKNOWN_SENTINEL) return null;
  if (value === 'N/A' || value === 'unknown') return null;
  return value;
}

/**
 * Stable cluster identity, independent of the sequential ids the analyzer
 * assigns per run. `domain:<base>` or `ip-exact:<ip>`.
 */
export function clusterKey(
  cluster: ClusterSummary,
  /** fqdn -> resolved IP, so an exact-IP cluster can name its address. */
  ipByFqdn?: Map<string, string | null>
): string {
  if (cluster.id.startsWith('ip-exact')) {
    // The analyzer names exact-IP clusters `ip-exact-<n>`, which is a per-run
    // sequence; the stable identity is the shared address. Falling back to the
    // run-local id keeps the two documents joinable when no rows are supplied.
    const ip = cluster.gateways
      .map((fqdn) => ipByFqdn?.get(fqdn) ?? null)
      .find((value): value is string => value !== null);
    return `ip-exact:${ip ?? cluster.id}`;
  }
  return `domain:${cluster.baseDomain}`;
}

/** The same identity, derived from a single gateway row. */
export function clusterKeyForGateway(
  gateway: GatewayAnalysis
): { key: string; kind: 'domain' | 'ip-exact' } | null {
  if (!gateway.clusterId) return null;
  if (gateway.clusterId.startsWith('ip-exact')) {
    const ip = normalizeSentinels(gateway.ipAddress);
    return ip ? { key: `ip-exact:${ip}`, kind: 'ip-exact' } : null;
  }
  return { key: `domain:${gateway.baseDomain}`, kind: 'domain' };
}

export function toNetworkDocument(
  summary: CentralizationReport,
  observers: ObserverIndependenceRollup | null,
  /**
   * Optional gateway rows. Supplied so an exact-IP cluster gets the same
   * `ip-exact:<ip>` key here as it does in the gateways document — the
   * cluster summary alone does not carry an address.
   */
  results?: GatewayAnalysis[]
): NetworkDocument {
  const ipByFqdn = new Map<string, string | null>(
    (results ?? []).map((gateway) => [gateway.fqdn, normalizeSentinels(gateway.ipAddress)])
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: summary.timestamp || new Date().toISOString(),
    totals: {
      gatewaysAnalyzed: summary.totalGateways,
      gatewaysInNetwork: summary.totalGatewaysInNetwork,
      resolved: summary.totalResolved,
      failedDns: summary.totalFailedDns,
      clustered: summary.clusteredGateways,
      highCentralization: summary.highCentralization,
    },
    clusters: summary.clusters.map((cluster) => ({
      id: cluster.id,
      key: clusterKey(cluster, ipByFqdn),
      size: cluster.size,
      avgScore: cluster.avgScore,
      baseDomain: cluster.baseDomain,
      pattern: cluster.pattern,
      gateways: cluster.gateways,
      wallets: cluster.wallets ?? [],
      totalRewards: cluster.totalRewards ?? null,
    })),
    topSuspicious: summary.topSuspicious.map((s) => ({
      fqdn: s.fqdn,
      score: s.score,
      reasons: s.reasons,
    })),
    infrastructure: summary.infrastructureImpact ?? null,
    economics: summary.economicImpact ?? null,
    versions: summary.versionStats ?? null,
    observers,
  };
}

export function toGatewayDocument(
  results: GatewayAnalysis[],
  observers: Map<string, GatewayObserverSummary>
): GatewaysDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    count: results.length,
    gateways: results.map((gateway) => {
      const cluster = clusterKeyForGateway(gateway);
      return {
        wallet: gateway.wallet,
        fqdn: gateway.fqdn,
        stake: gateway.stake,
        status: gateway.status,
        baseDomain: gateway.baseDomain,
        domainPattern: gateway.domainPattern,
        domainGroupSize: gateway.domainGroupSize,
        dnsResolved: gateway.ipAddress !== DNS_FAILURE_SENTINEL,
        ipAddress: normalizeSentinels(gateway.ipAddress),
        ipRange: normalizeSentinels(gateway.ipRange),
        asn: normalizeSentinels(gateway.asn),
        asnOrg: normalizeSentinels(gateway.asnOrg),
        isp: normalizeSentinels(gateway.isp),
        country: normalizeSentinels(gateway.country),
        countryCode: normalizeSentinels(gateway.countryCode),
        city: normalizeSentinels(gateway.city),
        latitude: gateway.latitude ?? null,
        longitude: gateway.longitude ?? null,
        hosting: gateway.hosting ?? null,
        arIoVersion: normalizeSentinels(gateway.arIoVersion),
        arIoRelease: normalizeSentinels(gateway.arIoRelease),
        clusterId: gateway.clusterId || null,
        clusterKey: cluster?.key ?? null,
        clusterKind: cluster?.kind ?? null,
        clusterSize: gateway.clusterSize,
        clusterRole: gateway.clusterRole,
        suspicionNotes: gateway.suspicionNotes,
        scores: {
          domain: gateway.domainCentralization,
          network: gateway.networkCentralization,
          stake: gateway.stakeCentralization,
          temporal: gateway.temporalCentralization,
          technical: gateway.technicalCentralization,
          geographic: gateway.geographicCentralization,
          overall: gateway.overallCentralization,
        },
        observer: observers.get(gateway.wallet) ?? null,
      };
    }),
  };
}

/** Findings are published verbatim; only the observer count is added. */
export function toPublishedFinding(finding: Finding): PublishedFinding {
  return {
    id: finding.id,
    kind: finding.kind,
    epochIndex: finding.epochIndex,
    observers: finding.observers,
    observerCount: finding.observers.length,
    severity: finding.severity,
    confidence: finding.confidence,
    detectedAt: finding.detectedAt,
    summary: finding.summary,
    detail: finding.detail,
  };
}
