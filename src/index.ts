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
    processId: process.env.IO_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
    analyzePerformance: process.env.ANALYZE_PERFORMANCE === 'true',
    useDemoData: process.env.USE_DEMO_DATA === 'true',
    minStake: parseInt(process.env.MIN_STAKE || '10000'),
  });
  
  try {
    await analyzer.analyze();
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();