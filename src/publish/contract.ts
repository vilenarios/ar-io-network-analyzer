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
import { DOMAIN_CLUSTER_PREFIX, IP_EXACT_CLUSTER_PREFIX } from '../analyzer-constants.js';
import type {
  Finding,
  GatewayObserverSummary,
  ObserverIndependenceRollup,
  Severity,
} from '../observers/types.js';

// 1.1 adds `capture` + `chain` to every epoch document, and makes
// `first/lastSubmittedAtUnix` nullable so an epoch nobody reported in can be
// published at all. Additive: 1.0 readers keep every field they had, and the
// two timestamps were never meaningful for an empty list because it could not
// previously exist.
export const SCHEMA_VERSION = '1.1';

/** The bitmap encoding published documents advertise but never interpret. */
export const GATEWAY_RESULTS_ENCODING = 'gar-bitmap-v1-lsb';

/**
 * The observer-namespace documents, at `/api/v1/<name>.json`.
 *
 * Distinct from `PORTAL_DOCUMENTS` (`/api/v1/portal/*`), which is the
 * low-latency snapshot the network portal reads. These are the analysis
 * outputs: the manifest, the daily centralization run (`network`, `gateways`)
 * and the observer-independence work (`observers`, `findings`). Per-epoch
 * documents live at `/api/v1/epochs/<n>.json` and are listed in the manifest.
 *
 * Exported so the server's router, the OpenAPI spec and the parity test all
 * read the same list. It used to be a regex literal in the router with no
 * shared source, which is how `network.json` and `gateways.json` ended up
 * served but absent from both the spec and the parity test's SERVED list —
 * invisible to a check that only ever compares those two lists to each other.
 */
export const OBSERVER_DOCUMENTS = [
  'index',
  'network',
  'gateways',
  'observers',
  'findings',
  'economics',
  'rewards',
] as const;

export type ObserverDocumentName = (typeof OBSERVER_DOCUMENTS)[number];

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
    /**
     * Retained protocol-economics series. Listed here so consumers can find it:
     * the network portal's availability check reads this map and will not
     * request a document that is absent from it, however well the server
     * serves it.
     */
    economics?: DocumentEntry;
  rewards?: DocumentEntry;
    epochs?: Array<DocumentEntry & { epochIndex: number }>;
    /**
     * Per-epoch gateway registry slot order — the key that turns an
     * observation's `gatewayResultsBase64` bitmap into gateway addresses.
     * Listed so consumers can discover it; the portal will not request a
     * document absent from this map.
     */
    registry?: Array<DocumentEntry & { epochIndex: number }>;
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
    registryApproximate: boolean;
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
  /**
   * true only when the registry slot order was snapshotted while this epoch
   * was live. false with `registryApproximate: true` means a snapshot exists
   * but was taken later, so bit i of a result blob may not name slot i.
   */
  registryCaptured: boolean;
  registryApproximate: boolean;
  registryDigest: string | null;
  /**
   * null when `observations` is empty — there is no first or last submission
   * to report. Always a number when the array is non-empty.
   */
  firstSubmittedAtUnix: number | null;
  lastSubmittedAtUnix: number | null;
  /**
   * Whether `observations` is the whole truth for this epoch, judged against
   * the chain's own tally. Read this BEFORE computing participation rates:
   *
   *   complete — we hold everything the chain counted (including 0 of 0)
   *   partial  — we hold some but fewer than the chain counted
   *   missing  — the chain counted submissions and we hold none
   *   unknown  — completeness is not knowable: either no chain-side count was
   *              captured, or the epoch is STILL RUNNING. The current epoch is
   *              always `unknown` — it starts with zero observations because
   *              nobody has reported yet, which must not be published as
   *              "nobody reported". Compare `chain.endTimestampUnix` to tell
   *              the two apart.
   *
   * An empty array with `complete` means nobody reported. An empty array with
   * `missing` means reports existed and are gone — `close_epoch` is
   * permissionless and reclaims the account, so they are unrecoverable.
   * See ../observers/capture-state.ts.
   */
  capture: 'complete' | 'partial' | 'missing' | 'unknown';
  /**
   * The chain's own account fields, when captured. `null` for epochs whose
   * Epoch account we never read. This is what lets a consumer verify `capture`
   * rather than trust it.
   */
  chain: {
    /** Epoch end, unix seconds. In the future means the window is still open. */
    endTimestampUnix: number | null;
    observerCount: number | null;
    observationsSubmitted: number | null;
    activeGatewayCount: number | null;
    hasObservedCount: number | null;
    /**
     * Total composite weight for the epoch, as a DECIMAL STRING. A u128 on
     * chain, so it has no JSON number representation — parse it as a bigint,
     * not a float. The denominator for a gateway's weighted reward share;
     * per-gateway `compositeWeight` is in the portal's gateways document.
     */
    totalCompositeWeight: string | null;
    /**
     * 32 bytes of frozen entropy, hex. Together with the epoch's registry slot
     * order (/api/v1/registry/{epochIndex}.json) this is what the SDK's
     * `predictPrescribedObservers` needs to VERIFY the protocol's observer
     * selection, rather than trusting the prescribed list.
     */
    hashchain: string | null;
    /**
     * The protocol's own statement that the observation window is shut. More
     * authoritative than comparing `endTimestampUnix` to the clock, which is
     * what `capture` still falls back on when this is null.
     */
    observationsClosed: boolean | null;
    /** Account layout version. A change here means decoders need review. */
    layoutVersion: string | null;
  } | null;
  /**
   * The protocol's OWN per-slot failure tally, aligned to the same registry
   * slot order as every observation's bitmap — so `failureCounts[i]` describes
   * the gateway at `gateways[i]` in /api/v1/registry/{epochIndex}.json.
   *
   * Publish-side cross-check, and the reason this is worth carrying: the number
   * of observers whose bit `i` is CLEARED must equal `failureCounts[i]`. A
   * decoder that inverts the polarity fails that check immediately. It is how
   * an inverted reading was caught before it shipped.
   *
   * Truncated to the epoch's gateway count; the on-chain array is a fixed 3000
   * entries and the tail is padding.
   */
  failureCounts: number[] | null;
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

/**
 * The gateway registry slot order for one epoch.
 *
 * This is the missing key to every observation's verdict bitmap.
 * `gatewayResultsBase64` is a bitmap indexed by gateway registry SLOT, not by
 * gateway address — so without this document a consumer can count how many
 * gateways an observer failed but cannot name a single one of them, and cannot
 * ask the reverse question ("who failed gateway X in epoch N") at all.
 *
 * `gateways[i]` is the gateway at bit `i`. Decode with the encoding named by
 * the observation's `gatewayResultsEncoding` (`gar-bitmap-v1-lsb`): bit `i` is
 * byte `i >> 3` of the decoded blob, shifted right by `i & 7`, masked with 1.
 * Only the first `gatewayResultsMeaningfulBytes` of the blob carry verdicts.
 *
 * POLARITY, AND GET IT RIGHT: a SET bit (1) means the observer found the
 * gateway HEALTHY. A CLEARED bit (0) is the failure. So
 * `failed = ((blob[i >> 3] >> (i & 7)) & 1) === 0`. Inverting this reports
 * every passing gateway as failing, which is worse than publishing nothing.
 * Confirmed two ways: ../observers/hamming.ts documents `0 = failed`, and the
 * chain's own per-slot `failure_counts` for epoch 559 equals the CLEARED-bit
 * count across observers for all 553 slots (and the set-bit count for none).
 *
 * ONLY TRUST THIS WHEN `inEpoch` IS TRUE. A snapshot taken after the epoch
 * closed is the CURRENT slot order wearing a past epoch's label: any gateway
 * that joined or left since shifts every slot after it, so bit `i` may not name
 * `gateways[i]`. Such epochs publish `approximate: true`, and the epoch
 * document says the same via `registryApproximate`.
 */
export interface RegistryDocument {
  schemaVersion: string;
  generatedAt: string;
  epochIndex: number;
  /** Gateways in the registry when the snapshot was taken. */
  gatewayCount: number;
  /** Snapshotted while this epoch was live — the only decodable kind. */
  inEpoch: boolean;
  /** The inverse of `inEpoch`, named as consumers will think of it. */
  approximate: boolean;
  /** Matches `registryDigest` on the epoch document, so the pair is verifiable. */
  digest: string;
  /** Unix seconds, and the Solana slot, at which the order was captured. */
  capturedAtUnix: number;
  capturedAtSlot: number;
  /** The registry account the order was read from. */
  registryPubkey: string;
  /** The bitmap encoding these slots index into. */
  encoding: string;
  /** `gateways[i]` is the gateway at bit `i`. */
  gateways: string[];
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
  /**
   * The feed carries a rolling window of epochs, not all history. Stated on
   * the wire so a consumer can distinguish a windowed feed from a complete
   * one, and knows where the remainder lives.
   */
  window: {
    /** Epochs retained; 0 means unwindowed. */
    epochs: number;
    /** Oldest epoch present, or null when there is nothing to window. */
    from: number | null;
    /** True when findings were dropped from this document. */
    truncated: boolean;
    /** Where the dropped findings remain addressable. */
    olderFindingsAt: string;
  };
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
  if (cluster.id.startsWith(IP_EXACT_CLUSTER_PREFIX)) {
    // The analyzer names exact-IP clusters `ip-exact-<n>`, which is a per-run
    // sequence; the stable identity is the shared address. Falling back to the
    // run-local id keeps the two documents joinable when no rows are supplied.
    const ip = cluster.gateways
      .map((fqdn) => ipByFqdn?.get(fqdn) ?? null)
      .find((value): value is string => value !== null);
    return `${IP_EXACT_CLUSTER_PREFIX}:${ip ?? cluster.id}`;
  }
  return `${DOMAIN_CLUSTER_PREFIX}:${cluster.baseDomain}`;
}

/** The same identity, derived from a single gateway row. */
export function clusterKeyForGateway(
  gateway: GatewayAnalysis
): { key: string; kind: 'domain' | 'ip-exact' } | null {
  if (!gateway.clusterId) return null;
  if (gateway.clusterId.startsWith(IP_EXACT_CLUSTER_PREFIX)) {
    const ip = normalizeSentinels(gateway.ipAddress);
    return ip ? { key: `${IP_EXACT_CLUSTER_PREFIX}:${ip}`, kind: 'ip-exact' } : null;
  }
  return { key: `${DOMAIN_CLUSTER_PREFIX}:${gateway.baseDomain}`, kind: 'domain' };
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

/**
 * Findings are published verbatim; only the observer count is added.
 *
 * `detectedAt` publishes `firstSeenAt` — when the finding was FIRST detected —
 * not the `detected_at` column, which the detector re-stamps to `now` on every
 * run. Those runs are hourly and re-evaluate every epoch in the window, so
 * `detected_at` on a two-week-old epoch reads as "seconds ago", every hour,
 * forever. Anyone asking "when did this collusion signal first appear?" got
 * today's date for a signal twelve days old.
 *
 * It also made every epoch document churn: identical data, new timestamps, new
 * bytes, new ETag, every hour — see `writeDocumentStable`.
 */
export function toPublishedFinding(
  finding: Finding & { firstSeenAt?: number | string }
): PublishedFinding {
  return {
    id: finding.id,
    kind: finding.kind,
    epochIndex: finding.epochIndex,
    observers: finding.observers,
    observerCount: finding.observers.length,
    severity: finding.severity,
    confidence: finding.confidence,
    detectedAt: firstSeenIso(finding) ?? finding.detectedAt,
    summary: finding.summary,
    detail: finding.detail,
  };
}

/** `firstSeenAt` is unix ms from the store, but may already be ISO. */
function firstSeenIso(finding: { firstSeenAt?: number | string }): string | null {
  const seen = finding.firstSeenAt;
  if (typeof seen === 'number' && Number.isFinite(seen)) {
    return new Date(seen).toISOString();
  }
  if (typeof seen === 'string' && seen) {
    const parsed = Date.parse(seen);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}
