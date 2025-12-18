#!/usr/bin/env node

/**
 * Arweave Node Network Analyzer
 *
 * A comprehensive tool to analyze the Arweave node network for centralization
 * patterns, peer relationships, and infrastructure distribution.
 */

import { ArweaveNodeAnalyzer } from './arweave-analyzer.js';
import { displayArweaveBanner } from './utils/arweave-display.js';
import { DEFAULT_SEED_NODES, fetchSeedNodesFromGateway } from './node-crawler.js';

function parseSeedNodes(envVar: string | undefined): string[] | null {
  if (!envVar) return null;
  return envVar
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  displayArweaveBanner();

  // Get seed nodes: from env var, or fetch from gateway, or use defaults
  let seedNodes = parseSeedNodes(process.env.SEED_NODES);
  if (!seedNodes) {
    console.log('Fetching initial seed nodes from arweave.net gateway...');
    seedNodes = await fetchSeedNodesFromGateway();
    if (seedNodes.length === 0) {
      seedNodes = DEFAULT_SEED_NODES;
    }
  }

  const analyzer = new ArweaveNodeAnalyzer({
    crawler: {
      seedNodes,
      maxNodes: parseInt(process.env.MAX_NODES || '5000'),
      timeout: parseInt(process.env.TIMEOUT || '3000'),
      concurrency: parseInt(process.env.CONCURRENCY || '30'),
      delayBetweenRequests: parseInt(process.env.DELAY || '20'),
      retries: parseInt(process.env.RETRIES || '1'),
    },
    skipGeo: process.env.SKIP_GEO === 'true',
    outputDir: process.env.OUTPUT_DIR || 'reports',
    useDemoData: process.env.USE_DEMO_DATA === 'true',
  });

  try {
    await analyzer.analyze();
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
