#!/usr/bin/env node

/**
 * AR.IO Gateway Centralization Analyzer
 *
 * A comprehensive tool to analyze gateway centralization patterns in the AR.IO network.
 * Detects potential same-actor gateways using multiple scoring methods.
 */

import { GatewayCentralizationAnalyzer } from './analyzer.js';
import { displayBanner } from './utils/display.js';

async function main() {
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

  try {
    await analyzer.analyze();
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
