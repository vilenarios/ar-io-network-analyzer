#!/usr/bin/env node

/**
 * AR.IO Gateway Centralization Analyzer
 *
 * A comprehensive tool to analyze gateway centralization patterns in the AR.IO network.
 * Detects potential same-actor gateways using multiple scoring methods.
 */

import type { Database } from 'better-sqlite3';
import { GatewayCentralizationAnalyzer } from './analyzer.js';
import { displayBanner } from './utils/display.js';
import { assertNodeVersion, scrubSecrets } from './utils/runtime.js';
import { openWriter } from './db/index.js';
import { finishAnalysisRun, startAnalysisRun } from './db/repo-write.js';

/**
 * Analysis-run bookkeeping is best-effort: a missing database must not stop
 * the daily analysis, it only costs the server's freshness signal.
 */
function openRunLog(): { db: Database; runId: number } | null {
  try {
    const db = openWriter();
    return { db, runId: startAnalysisRun(db, Date.now()) };
  } catch {
    return null;
  }
}

async function main() {
  assertNodeVersion();
  displayBanner();

  const analyzer = new GatewayCentralizationAnalyzer({
    processId: process.env.ARIO_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
    analyzePerformance: process.env.ANALYZE_PERFORMANCE !== 'false', // default: true
    useDemoData: process.env.USE_DEMO_DATA === 'true',
    minStake: parseInt(process.env.MIN_STAKE || '10000'),
    dnsConcurrency: parseInt(process.env.DNS_CONCURRENCY || '50'),
    fingerprintConcurrency: parseInt(process.env.FINGERPRINT_CONCURRENCY || '20'),
    // With the Solana SDK, gateway addresses are Solana pubkeys (not Arweave
    // wallets) — the Goldsky AR-IO-Solana-Registration lookup (keyed on Arweave
    // owner) would return no matches. Default to skipping; set SKIP_MIGRATION_CHECK=false
    // to force on for historical/Arweave-keyed datasets.
    skipMigrationCheck: process.env.SKIP_MIGRATION_CHECK !== 'false',
  });

  const runLog = openRunLog();

  try {
    const { results, summary } = await analyzer.analyze();
    if (runLog) {
      finishAnalysisRun(runLog.db, runLog.runId, {
        status: 'ok',
        gatewayCount: results.length,
        resolvedCount: summary.totalResolved,
        clusterCount: summary.clusters.length,
      });
    }
  } catch (error) {
    // Publish nothing on failure — yesterday's public/ stays intact.
    if (runLog) {
      finishAnalysisRun(runLog.db, runLog.runId, {
        status: 'failed',
        error: scrubSecrets(error),
      });
    }
    console.error('\n❌ Fatal error:', scrubSecrets(error));
    process.exit(1);
  } finally {
    runLog?.db.close();
  }
}

main();
