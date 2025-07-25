/**
 * Report generation utilities
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import type { GatewayAnalysis, CentralizationReport } from '../types.js';

export function generateCSV(results: GatewayAnalysis[]): string {
  const csvLines: string[] = [
    // Header
    'fqdn,wallet,stake,status,baseDomain,domainPattern,domainGroupSize,ipAddress,ipRange,' +
    'responseTime,serverHeader,certIssuer,registrationDate,clusterId,clusterSize,clusterRole,' +
    'domainScore,networkScore,stakeScore,temporalScore,technicalScore,overallScore,suspicionNotes'
  ];
  
  // Data rows
  results.forEach(result => {
    csvLines.push([
      result.fqdn,
      result.wallet,
      result.stake.toString(),
      result.status,
      result.baseDomain,
      result.domainPattern,
      result.domainGroupSize.toString(),
      result.ipAddress,
      result.ipRange,
      result.responseTime?.toString() || 'N/A',
      result.serverHeader || 'N/A',
      result.certIssuer || 'N/A',
      result.registrationTimestamp ? new Date(result.registrationTimestamp).toISOString() : 'N/A',
      result.clusterId,
      result.clusterSize.toString(),
      result.clusterRole,
      result.domainCentralization.toFixed(3),
      result.networkCentralization.toFixed(3),
      result.stakeCentralization.toFixed(3),
      result.temporalCentralization.toFixed(3),
      result.technicalCentralization.toFixed(3),
      result.overallCentralization.toFixed(3),
      result.suspicionNotes.join(';')
    ].map(escapeCSV).join(','));
  });
  
  const csv = csvLines.join('\n');
  
  // Create reports directory if it doesn't exist
  const reportsDir = 'reports';
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  
  const filename = `reports/gateway-centralization-${new Date().toISOString().split('T')[0]}.csv`;
  writeFileSync(filename, csv);
  
  return filename;
}

export function generateJSON(report: CentralizationReport): string {
  // Ensure reports directory exists
  const reportsDir = 'reports';
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  
  const filename = `reports/gateway-centralization-summary-${new Date().toISOString().split('T')[0]}.json`;
  writeFileSync(filename, JSON.stringify(report, null, 2));
  return filename;
}

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}