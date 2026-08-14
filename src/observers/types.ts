/**
 * Shared vocabulary for the observer-independence capability.
 *
 * Everything the capture daemon persists and everything a detector may read is
 * described here. Detectors are pure functions over these types: no I/O, no
 * network, no clock beyond `ctx.now`.
 */

/** Exactly what `deserializeObservation` returns, plus capture provenance. */
export interface ObservationRecord {
  epochIndex: number;
  observer: string; // base58; === GatewayAnalysis.wallet
  pubkey: string; // account PDA
  gatewayResults: Buffer; // raw 375 bytes, immutable
  gatewayCount: number; // u16 — defines the meaningful bitmap prefix
  reportTxId: string; // 43-char base64url; NOT unique
  submittedAt: number; // chain unix SECONDS
  schemaVersion: { major: number; minor: number; patch: number } | null;
  accountBytes: number;
  suspectTimestamp: boolean;
  revision: number;
  firstSeenAt: number;
  lastSeenAt: number; // local unix ms
  firstSeenSlot: number;
  lastSeenSlot: number; // RPC context slot
}

/** An observation as first decoded — before the store assigns provenance. */
export type DecodedObservation = Omit<
  ObservationRecord,
  'firstSeenAt' | 'lastSeenAt' | 'firstSeenSlot' | 'lastSeenSlot' | 'revision'
>;

export interface RegistrySnapshot {
  epochIndex: number;
  gatewayCount: number;
  capturedAt: number;
  capturedAtSlot: number;
  digest: string;
  registryPubkey: string;
  slots: string[]; // slots[i] = gateway address at bit index i
  /**
   * true when the snapshot was taken while this epoch was still the live one.
   * false means it is the CURRENT slot order labelled with a past epoch — an
   * approximation, because any gateway that joined or left since shifts every
   * slot after it. Only an in-epoch snapshot makes a bitmap decodable.
   */
  inEpoch: boolean;
}

export interface EpochSnapshot {
  epochIndex: number;
  observations: ObservationRecord[];
  distinctReportTxIds: number;
  firstSubmittedAtUnix: number;
  lastSubmittedAtUnix: number;
  /** null => no slot order captured; `inEpoch: false` => approximate only. */
  registry: RegistrySnapshot | null;
}

export type FindingKind =
  | 'shared_report_tx'
  | 'identical_results'
  | 'near_identical_results'
  | 'co_submission_timing'
  | 'shared_ip'
  | 'shared_ip_range'
  | 'shared_base_domain'
  | 'shared_asn'
  | 'analyzer_cluster_overlap'
  | 'unmatched_observer'
  | 'composite_independence_risk'
  | 'persistent_correlation'
  | 'detector_error';

export type Severity = 'info' | 'low' | 'medium' | 'high';

export const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high'];

export interface Finding {
  id: string; // `${kind}:${epochIndex ?? 'all'}:${observerHash12}`
  kind: FindingKind;
  epochIndex: number | null;
  observers: string[]; // ASCII-sorted BEFORE hashing — or ids churn
  severity: Severity;
  confidence: number; // 0..1
  detectedAt: string; // ISO 8601 Z
  summary: string; // one sentence, safe to render verbatim
  detail: Record<string, unknown>;
}

/** A finding as stored, carrying the first time it was ever observed. */
export interface StoredFinding extends Finding {
  firstSeenAt: number; // local unix ms
  detectorVersion: number;
}

/** Projection of GatewayAnalysis — detectors see only what they need. */
export interface GatewayFacts {
  wallet: string;
  fqdn: string;
  ipAddress: string | null; // 'resolution_failed' normalized to null
  ipRange: string | null;
  asn: string | null;
  asnOrg: string | null;
  baseDomain: string;
  clusterKey: string | null; // stable: 'domain:<d>' | 'ip-exact:<ip>'
  clusterKind: 'domain' | 'ip-exact' | null;
  clusterSize: number;
  stake: number; // mARIO
  overallCentralization: number;
}

export interface DetectorConfig {
  similarityThreshold: number; // UNCALIBRATED default 0.90
  calibrated: boolean;
  calibrationId: number | null;
  coSubmissionWindowSeconds: number; // default 60
  sharedAsnMinObservers: number; // default 4
  persistentMinEpochs: number; // default 3
  compositeMinKinds: number; // default 2
  windowEpochs: number; // default 30
  detectorVersion: number;
}

/**
 * Everything a detector may read. Detectors are PURE: no I/O, no network, no
 * clock beyond ctx.now. A detector that needs DNS or geo is a bug.
 */
export interface DetectorContext {
  epoch: EpochSnapshot;
  epochs: EpochSnapshot[]; // rolling window, ascending, for cross-epoch kinds
  gateways: Map<string, GatewayFacts>; // key = wallet === observer
  gatewaySnapshotAt: string | null; // ISO; null => no analysis published yet
  config: DetectorConfig;
  now: number; // local unix ms, injected for determinism
  /**
   * Findings produced by earlier detectors in this run. Empty for the
   * per-epoch detectors (#1–#10); the rollup detectors (#11, #12) consume it.
   */
  priorFindings: Finding[];
}

export interface Detector {
  kind: FindingKind;
  /** true only for detectors that interpret bitmap CONTENT. All v1 detectors are false. */
  requiresDecodedResults: boolean;
  /**
   * 'epoch' detectors run once per epoch in the window; 'window' detectors run
   * once over the whole window and consume `ctx.priorFindings`.
   */
  scope: 'epoch' | 'window';
  run(ctx: DetectorContext): Finding[];
}

/** Rolled-up observer independence, embedded in the network document. */
export interface ObserverIndependenceRollup {
  generatedAt: string;
  epochRange: { from: number; to: number; count: number } | null;
  observerCount: number;
  findingCount: number;
  bySeverity: Record<Severity, number>;
  byKind: Record<string, number>;
  calibrated: boolean;
  topFindings: Array<{
    id: string;
    kind: FindingKind;
    epochIndex: number | null;
    severity: Severity;
    confidence: number;
    observerCount: number;
    summary: string;
  }>;
}

/** Per-gateway observer facts, joined into the gateways document. */
export interface GatewayObserverSummary {
  observer: string;
  epochsObserved: number;
  firstEpochIndex: number | null;
  lastEpochIndex: number | null;
  findingCount: number;
  maxSeverity: Severity | null;
  kinds: FindingKind[];
}
