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
import { countFindings, rankFindings, summarizeObservers } from './rollup.js';
import type { DetectorConfig, EpochSnapshot, Finding, GatewayFacts } from './types.js';

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
    registryCaptured: epoch.registry?.inEpoch === true,
    registryApproximate: epoch.registry !== null && !epoch.registry.inEpoch,
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
  const byObserver = summarizeObservers(epochs, findings);

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
      registryCaptured: epoch.registry?.inEpoch === true,
      registryApproximate: epoch.registry !== null && !epoch.registry.inEpoch,
      findingCount: findingsByEpoch.get(epoch.epochIndex) ?? 0,
      firstSubmittedAtUnix: epoch.firstSubmittedAtUnix,
      lastSubmittedAtUnix: epoch.lastSubmittedAtUnix,
    })),
  };
}

/**
 * Epochs of findings carried in the rolling feed.
 *
 * Without a window this document grows without bound: it is regenerated with
 * every finding ever produced, so at the protocol's 50-observer cap it would
 * reach tens of MiB within a year and a portal would fetch all of it to render
 * a dashboard. Older findings remain addressable per epoch via
 * `epochs/<index>.json`, which is naturally bounded, so nothing is lost —
 * only the feed is trimmed.
 *
 * Override with FINDINGS_FEED_EPOCHS; 0 disables the window.
 */
export const DEFAULT_FINDINGS_FEED_EPOCHS = 30;

function findingsFeedEpochs(): number {
  const raw = process.env.FINDINGS_FEED_EPOCHS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FINDINGS_FEED_EPOCHS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_FINDINGS_FEED_EPOCHS;
}

export function buildFindingsDocument(
  findings: Finding[],
  epochs: EpochSnapshot[],
  config: DetectorConfig
): FindingsDocument {
  const windowSize = findingsFeedEpochs();

  // Window by epoch, not by finding count, so an epoch is never half-present.
  let windowed = findings;
  let windowFrom: number | null = null;
  if (windowSize > 0 && findings.length > 0) {
    // Cross-epoch detector kinds may carry a null epochIndex; those are
    // never windowed out, since they describe the window itself.
    const present = [
      ...new Set(
        findings
          .map((f) => f.epochIndex)
          .filter((e): e is number => typeof e === 'number')
      ),
    ].sort((a, b) => b - a);
    const kept = new Set(present.slice(0, windowSize));
    windowFrom = kept.size > 0 ? Math.min(...kept) : null;
    windowed = findings.filter(
      (f) => typeof f.epochIndex !== 'number' || kept.has(f.epochIndex)
    );
  }

  const { bySeverity, byKind } = countFindings(windowed);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    detectorVersion: config.detectorVersion,
    calibrated: config.calibrated,
    calibrationId: config.calibrationId,
    thresholdSimilarity: config.similarityThreshold,
    epochRange: epochRange(epochs),
    // Stated explicitly so a consumer can tell a windowed feed from a
    // complete one, and knows where to look for the remainder.
    window: {
      epochs: windowSize,
      from: windowFrom,
      truncated: windowed.length < findings.length,
      olderFindingsAt: 'epochs/<epochIndex>.json',
    },
    counts: { total: windowed.length, bySeverity, byKind },
    findings: rankFindings(windowed).map(toPublishedFinding),
  };
}
