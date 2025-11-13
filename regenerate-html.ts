#!/usr/bin/env node
/**
 * Script to regenerate HTML report from existing CSV and JSON data
 */

import { readFileSync, writeFileSync } from 'fs';
import { generateHTMLReport } from './src/utils/html-generator.js';
import type { CentralizationReport, GatewayAnalysis } from './src/types.js';

// Read the date from command line or use latest
const date = process.argv[2] || '2025-11-13';

console.log(`Regenerating HTML report for ${date}...`);

// Read JSON summary
const jsonPath = `reports/gateway-centralization-summary-${date}.json`;
const summary: CentralizationReport = JSON.parse(readFileSync(jsonPath, 'utf-8'));

// Read CSV data
const csvPath = `reports/gateway-centralization-${date}.csv`;
const csvContent = readFileSync(csvPath, 'utf-8');
const lines = csvContent.split('\n').slice(1); // Skip header

// Parse CSV into gateway analysis objects
const csvData: GatewayAnalysis[] = lines
  .filter(line => line.trim())
  .map(line => {
    const cols = line.split(',');
    return {
      fqdn: cols[0],
      wallet: cols[1],
      stake: parseFloat(cols[2]) || 0,
      status: cols[3],
      baseDomain: cols[4],
      domainPattern: cols[5],
      domainGroupSize: parseInt(cols[6]) || 0,
      ipAddress: cols[7],
      ipRange: cols[8],
      country: cols[9],
      countryCode: cols[10],
      region: cols[11],
      city: cols[12],
      latitude: parseFloat(cols[13]) || undefined,
      longitude: parseFloat(cols[14]) || undefined,
      timezone: cols[15],
      isp: cols[16],
      asn: cols[17],
      hosting: cols[18] === 'true',
      responseTime: parseFloat(cols[19]) || undefined,
      serverHeader: cols[20],
      httpVersion: cols[21],
      certIssuer: cols[22],
      registrationTimestamp: parseInt(cols[23]) || undefined,
      domainCentralization: parseFloat(cols[24]) || 0,
      geographicCentralization: parseFloat(cols[25]) || 0,
      networkCentralization: parseFloat(cols[26]) || 0,
      temporalCentralization: parseFloat(cols[27]) || 0,
      technicalCentralization: parseFloat(cols[28]) || 0,
      stakeCentralization: parseFloat(cols[29]) || 0,
      overallCentralization: parseFloat(cols[30]) || 0,
      clusterId: cols[31],
      clusterSize: parseInt(cols[32]) || 0,
      clusterRole: (cols[33] as 'primary' | 'secondary') || 'primary',
      suspicionNotes: cols[34] ? cols[34].split(';').filter(Boolean) : []
    };
  });

console.log(`Loaded ${csvData.length} gateways from CSV`);
console.log(`Found ${csvData.filter(g => g.latitude && g.longitude).length} gateways with geographic data`);

// Generate new HTML with globe
const htmlContent = generateHTMLReport(
  summary,
  csvData,
  `gateway-centralization-${date}.csv`,
  `gateway-centralization-summary-${date}.json`
);

// Write to file (overwrite existing)
const outputPath = `reports/gateway-centralization-report-${date}.html`;
writeFileSync(outputPath, htmlContent);

console.log(`✅ Generated HTML report: ${outputPath}`);
console.log(`\nReport includes:`);
console.log(`  • Interactive 3D globe visualization`);
console.log(`  • Infrastructure analysis with provider/country breakdown`);
console.log(`  • TLD distribution chart (ArNS resilience)`);
console.log(`\nOpen in your browser to view!`);
