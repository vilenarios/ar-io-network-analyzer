/**
 * The observer view the daily analysis joins against.
 *
 * This lives here, not in `publish/`, because it is a query over the
 * observation store plus a rollup — and `publish/` exists to do exactly one
 * thing: write `public/` atomically. It reuses `rollup.ts` so the numbers it
 * produces cannot drift from the ones in `observers.json`.
 *
 * Everything degrades to empty rather than throwing: a box that has never
 * captured must still be able to run `yarn analyze`.
 */

import { tryOpenReader } from '../db/index.js';
import { getObservationsForEpochs, listEpochs, listFindings } from '../db/repo-read.js';
import {
  countFindings,
  rankFindings,
  summarizeObservers,
  toGatewayObserverSummaries,
} from './rollup.js';
import type { Finding, GatewayObserverSummary, ObserverIndependenceRollup } from './types.js';

/** How many epochs of history the daily join looks at. */
const DEFAULT_WINDOW_EPOCHS = 30;
const TOP_FINDINGS = 20;

export interface ObserverPublishContext {
  rollup: ObserverIndependenceRollup | null;
  byGateway: Map<string, GatewayObserverSummary>;
  /** Ranked findings for the HTML report's Observers tab; empty hides the tab. */
  findings: Finding[];
}

const EMPTY: ObserverPublishContext = { rollup: null, byGateway: new Map(), findings: [] };

function windowEpochs(): number {
  const raw = Number(process.env.OBSERVER_WINDOW_EPOCHS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_EPOCHS;
}

/**
 * Join observer findings onto the gateway roster for the daily analysis.
 * Returns empty context when no observations have been captured yet.
 */
export function loadObserverContext(): ObserverPublishContext {
  const db = tryOpenReader();
  if (!db) return EMPTY;

  try {
    const known = listEpochs(db);
    if (known.length === 0) return EMPTY;

    const selected = known.slice(-windowEpochs());
    const epochs = getObservationsForEpochs(
      db,
      selected.map((e) => e.epochIndex)
    );

    const findings = listFindings(db, {
      epochIndexes: selected.map((e) => e.epochIndex),
      includeCrossEpoch: true,
    });

    const accumulators = summarizeObservers(epochs, findings);
    const byGateway = toGatewayObserverSummaries(accumulators);
    const { bySeverity, byKind } = countFindings(findings);
    const ranked = rankFindings(findings);

    const calibrated = findings.some(
      (f) => f.kind === 'near_identical_results' && f.detail.calibrated === true
    );

    const rollup: ObserverIndependenceRollup = {
      generatedAt: new Date().toISOString(),
      epochRange:
        epochs.length === 0
          ? null
          : {
              from: epochs[0].epochIndex,
              to: epochs[epochs.length - 1].epochIndex,
              count: epochs.length,
            },
      observerCount: byGateway.size,
      findingCount: findings.length,
      bySeverity,
      byKind,
      calibrated,
      topFindings: ranked.slice(0, TOP_FINDINGS).map((f) => ({
        id: f.id,
        kind: f.kind,
        epochIndex: f.epochIndex,
        severity: f.severity,
        confidence: f.confidence,
        observerCount: f.observers.length,
        summary: f.summary,
      })),
    };

    return { rollup, byGateway, findings: ranked };
  } catch {
    // A corrupt or half-migrated store costs the Observers tab, not the run.
    return EMPTY;
  } finally {
    db.close();
  }
}
