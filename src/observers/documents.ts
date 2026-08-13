/**
 * Projections from stored observations and findings into published documents.
 *
 * Pure: these functions read nothing and write nothing. The raw result blob is
 * published verbatim, annotated with how many of its bytes are meaningful —
 * the portal must still not interpret it.
 */

import {
  GATEWAY_RESULTS_ENCODING,
  SCHEMA_VERSION,
  dateToIso,
  toPublishedFinding,
  type EpochDocument,
  type FindingsDocument,
  type ObserversDocument,
} from '../publish/contract.js';
import { meaningfulBytes } from './hamming.js';
import { SEVERITY_ORDER } from './types.js';
import type { DetectorConfig, EpochSnapshot, Finding, GatewayFacts, Severity } from './types.js';

function epochRange(epochs: EpochSnapshot[]) {
  if (epochs.length === 0) return null;
  return {
    from: epochs[0].epochIndex,
    to: epochs[epochs.length - 1].epochIndex,
    count: epochs.length,
  };
}

export function buildEpochDocument(epoch: EpochSnapshot, findings: Finding[]): EpochDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    epochIndex: epoch.epochIndex,
    observationCount: epoch.observations.length,
    distinctReportTxIds: epoch.distinctReportTxIds,
    registryCaptured: epoch.registry !== null,
    registryDigest: epoch.registry?.digest ?? null,
    firstSubmittedAtUnix: epoch.firstSubmittedAtUnix,
    lastSubmittedAtUnix: epoch.lastSubmittedAtUnix,
    observations: epoch.observations.map((observation) => ({
      observer: observation.observer,
      pubkey: observation.pubkey,
      reportTxId: observation.reportTxId,
      submittedAtUnix: observation.submittedAt,
      submittedAt: dateToIso(observation.submittedAt, 's'),
      suspectTimestamp: observation.suspectTimestamp,
      gatewayCount: observation.gatewayCount,
      gatewayResultsBase64: observation.gatewayResults.toString('base64'),
      gatewayResultsMeaningfulBytes: meaningfulBytes(observation.gatewayCount),
      gatewayResultsEncoding: GATEWAY_RESULTS_ENCODING,
      accountBytes: observation.accountBytes,
      schemaVersion: observation.schemaVersion
        ? `${observation.schemaVersion.major}.${observation.schemaVersion.minor}.${observation.schemaVersion.patch}`
        : null,
      revision: observation.revision,
      firstSeenAt: new Date(observation.firstSeenAt).toISOString(),
      lastSeenAt: new Date(observation.lastSeenAt).toISOString(),
    })),
    findings: findings
      .filter((finding) => finding.epochIndex === epoch.epochIndex)
      .map(toPublishedFinding),
  };
}

export function buildObserversDocument(
  epochs: EpochSnapshot[],
  findings: Finding[],
  gateways: Map<string, GatewayFacts>
): ObserversDocument {
  interface Accumulator {
    observer: string;
    epochIndexes: number[];
    reportTxIds: Set<string>;
    sharedReportEpochs: Set<number>;
    findingCount: number;
    maxSeverity: Severity | null;
    kinds: Set<string>;
  }

  const byObserver = new Map<string, Accumulator>();
  const get = (observer: string): Accumulator => {
    let entry = byObserver.get(observer);
    if (!entry) {
      entry = {
        observer,
        epochIndexes: [],
        reportTxIds: new Set(),
        sharedReportEpochs: new Set(),
        findingCount: 0,
        maxSeverity: null,
        kinds: new Set(),
      };
      byObserver.set(observer, entry);
    }
    return entry;
  };

  for (const epoch of epochs) {
    const reportCounts = new Map<string, number>();
    for (const observation of epoch.observations) {
      reportCounts.set(observation.reportTxId, (reportCounts.get(observation.reportTxId) ?? 0) + 1);
    }

    for (const observation of epoch.observations) {
      const entry = get(observation.observer);
      entry.epochIndexes.push(epoch.epochIndex);
      entry.reportTxIds.add(observation.reportTxId);
      if ((reportCounts.get(observation.reportTxId) ?? 0) > 1) {
        entry.sharedReportEpochs.add(epoch.epochIndex);
      }
    }
  }

  for (const finding of findings) {
    for (const observer of finding.observers) {
      const entry = byObserver.get(observer);
      if (!entry) continue;
      entry.findingCount++;
      entry.kinds.add(finding.kind);
      if (
        entry.maxSeverity === null ||
        SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(entry.maxSeverity)
      ) {
        entry.maxSeverity = finding.severity;
      }
    }
  }

  const findingsByEpoch = new Map<number, number>();
  for (const finding of findings) {
    if (finding.epochIndex === null) continue;
    findingsByEpoch.set(finding.epochIndex, (findingsByEpoch.get(finding.epochIndex) ?? 0) + 1);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    epochRange: epochRange(epochs),
    observerCount: byObserver.size,
    observers: [...byObserver.values()]
      .sort((a, b) => b.findingCount - a.findingCount || a.observer.localeCompare(b.observer))
      .map((entry) => ({
        observer: entry.observer,
        fqdn: gateways.get(entry.observer)?.fqdn ?? null,
        epochsObserved: entry.epochIndexes.length,
        firstEpochIndex: entry.epochIndexes.length > 0 ? Math.min(...entry.epochIndexes) : null,
        lastEpochIndex: entry.epochIndexes.length > 0 ? Math.max(...entry.epochIndexes) : null,
        distinctReportTxIds: entry.reportTxIds.size,
        sharedReportEpochs: entry.sharedReportEpochs.size,
        findingCount: entry.findingCount,
        maxSeverity: entry.maxSeverity,
        kinds: [...entry.kinds].sort(),
      })),
    epochs: epochs.map((epoch) => ({
      epochIndex: epoch.epochIndex,
      observationCount: epoch.observations.length,
      distinctReportTxIds: epoch.distinctReportTxIds,
      registryCaptured: epoch.registry !== null,
      findingCount: findingsByEpoch.get(epoch.epochIndex) ?? 0,
      firstSubmittedAtUnix: epoch.firstSubmittedAtUnix,
      lastSubmittedAtUnix: epoch.lastSubmittedAtUnix,
    })),
  };
}

export function buildFindingsDocument(
  findings: Finding[],
  epochs: EpochSnapshot[],
  config: DetectorConfig
): FindingsDocument {
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0 };
  const byKind: Record<string, number> = {};

  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    detectorVersion: config.detectorVersion,
    calibrated: config.calibrated,
    calibrationId: config.calibrationId,
    thresholdSimilarity: config.similarityThreshold,
    epochRange: epochRange(epochs),
    counts: { total: findings.length, bySeverity, byKind },
    findings: findings
      .slice()
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
          b.confidence - a.confidence ||
          (b.epochIndex ?? Number.MAX_SAFE_INTEGER) - (a.epochIndex ?? Number.MAX_SAFE_INTEGER)
      )
      .map(toPublishedFinding),
  };
}
