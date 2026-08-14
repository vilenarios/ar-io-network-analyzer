/**
 * The one implementation of "roll findings up per observer".
 *
 * Three consumers need the same aggregate — `observers.json`, the network
 * document's independence rollup, and the daily HTML report's Observers tab —
 * and each of them previously computed it, including a character-for-character
 * copy of the ranking comparator. Two implementations of one rollup drift; the
 * severity of a gateway on the portal would eventually disagree with the
 * severity of the same gateway in the report, with nothing to say which was
 * right. Everything below is pure: no I/O, no clock.
 */

import { SEVERITY_ORDER } from './types.js';
import type {
  EpochSnapshot,
  Finding,
  FindingKind,
  GatewayObserverSummary,
  Severity,
} from './types.js';

export interface ObserverAccumulator {
  observer: string;
  epochIndexes: number[];
  reportTxIds: Set<string>;
  /** Epochs where this observer's report tx was also submitted by someone else. */
  sharedReportEpochs: Set<number>;
  findingCount: number;
  maxSeverity: Severity | null;
  kinds: Set<string>;
}

/**
 * Rank findings for presentation: worst severity first, then confidence, then
 * newest epoch. Cross-epoch findings (`epochIndex: null`) sort as newest —
 * they summarise the whole window.
 */
export function rankFindings<T extends Finding>(findings: T[]): T[] {
  return findings
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
        b.confidence - a.confidence ||
        (b.epochIndex ?? Number.MAX_SAFE_INTEGER) - (a.epochIndex ?? Number.MAX_SAFE_INTEGER)
    );
}

export interface FindingCounts {
  bySeverity: Record<Severity, number>;
  byKind: Record<string, number>;
}

export function countFindings(findings: Finding[]): FindingCounts {
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0 };
  const byKind: Record<string, number> = {};

  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }
  return { bySeverity, byKind };
}

export function worseSeverity(current: Severity | null, candidate: Severity): Severity {
  if (current === null) return candidate;
  return SEVERITY_ORDER.indexOf(candidate) > SEVERITY_ORDER.indexOf(current) ? candidate : current;
}

/**
 * Per-observer aggregate over a window of epochs plus the findings computed
 * for it. Observers appear here iff they submitted an observation in the
 * window; a finding naming an observer we never captured is ignored rather
 * than inventing a row for it.
 */
export function summarizeObservers(
  epochs: EpochSnapshot[],
  findings: Finding[]
): Map<string, ObserverAccumulator> {
  const byObserver = new Map<string, ObserverAccumulator>();

  const get = (observer: string): ObserverAccumulator => {
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
    // reportTxId is NOT unique per observation — epoch 511 had 17 observations
    // and 11 distinct reports — so "shared" is a per-epoch count, never an
    // assumption of uniqueness.
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
      entry.maxSeverity = worseSeverity(entry.maxSeverity, finding.severity);
    }
  }

  return byObserver;
}

/** The projection the gateways document and the HTML report join against. */
export function toGatewayObserverSummaries(
  accumulators: Map<string, ObserverAccumulator>
): Map<string, GatewayObserverSummary> {
  const summaries = new Map<string, GatewayObserverSummary>();

  for (const entry of accumulators.values()) {
    summaries.set(entry.observer, {
      observer: entry.observer,
      epochsObserved: entry.epochIndexes.length,
      firstEpochIndex: entry.epochIndexes.length > 0 ? Math.min(...entry.epochIndexes) : null,
      lastEpochIndex: entry.epochIndexes.length > 0 ? Math.max(...entry.epochIndexes) : null,
      findingCount: entry.findingCount,
      maxSeverity: entry.maxSeverity,
      kinds: [...entry.kinds].sort() as FindingKind[],
    });
  }

  return summaries;
}
