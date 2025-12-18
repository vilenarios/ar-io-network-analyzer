/**
 * Console display utilities for Arweave node analyzer
 */

import type { ArweaveNetworkReport } from '../arweave-types.js';

export function displayArweaveBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     █████╗ ██████╗ ██╗    ██╗███████╗ █████╗ ██╗   ██╗███████╗║
║    ██╔══██╗██╔══██╗██║    ██║██╔════╝██╔══██╗██║   ██║██╔════╝║
║    ███████║██████╔╝██║ █╗ ██║█████╗  ███████║██║   ██║█████╗  ║
║    ██╔══██║██╔══██╗██║███╗██║██╔══╝  ██╔══██║╚██╗ ██╔╝██╔══╝  ║
║    ██║  ██║██║  ██║╚███╔███╔╝███████╗██║  ██║ ╚████╔╝ ███████╗║
║    ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝║
║                                                               ║
║              Node Network Analyzer v1.0                       ║
║        Peer Graph & Centralization Analysis                   ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
}

export function printArweaveSummary(report: ArweaveNetworkReport): void {
  console.log('\n' + '═'.repeat(65));
  console.log('                    ANALYSIS SUMMARY');
  console.log('═'.repeat(65));

  // Network Overview
  console.log('\n📊 NETWORK OVERVIEW');
  console.log('─'.repeat(40));
  console.log(`  Total Nodes Discovered:    ${report.totalNodesDiscovered}`);
  console.log(`  Responsive Nodes:          ${report.totalNodesResponsive}`);
  console.log(`  Failed/Unreachable:        ${report.totalNodesFailed}`);
  console.log(`  Crawl Duration:            ${(report.crawlDuration / 1000).toFixed(1)}s`);

  // Graph Metrics
  console.log('\n🔗 PEER GRAPH METRICS');
  console.log('─'.repeat(40));
  console.log(`  Total Edges:               ${report.totalEdges}`);
  console.log(`  Bidirectional Edges:       ${report.bidirectionalEdges}`);
  console.log(`  Network Density:           ${(report.networkDensity * 100).toFixed(4)}%`);
  console.log(`  Avg Clustering Coef:       ${report.avgClusteringCoefficient.toFixed(4)}`);
  console.log(`  Connected Components:      ${report.componentCount}`);
  console.log(`  Avg Peer Count:            ${report.avgPeerCount.toFixed(1)}`);
  console.log(`  Median Peer Count:         ${report.medianPeerCount}`);

  // Centralization Summary
  console.log('\n🎯 CONCENTRATION SUMMARY');
  console.log('─'.repeat(40));
  const highPct = ((report.highCentralization / report.totalNodesResponsive) * 100).toFixed(1);
  const medPct = ((report.mediumCentralization / report.totalNodesResponsive) * 100).toFixed(1);
  const lowPct = ((report.lowCentralization / report.totalNodesResponsive) * 100).toFixed(1);
  console.log(`  High (>0.7):               ${report.highCentralization} (${highPct}%)`);
  console.log(`  Medium (0.4-0.7):          ${report.mediumCentralization} (${medPct}%)`);
  console.log(`  Low (<0.4):                ${report.lowCentralization} (${lowPct}%)`);
  console.log(`  Clustered Nodes:           ${report.clusteredNodes}`);

  // Infrastructure
  console.log('\n🏢 INFRASTRUCTURE DISTRIBUTION (Responsive Nodes Only)');
  console.log('─'.repeat(40));
  console.log(
    `  Datacenter Hosted:         ${report.infrastructureImpact.totalDatacenterHosted} (${report.infrastructureImpact.datacenterPercentage.toFixed(1)}%)`
  );
  console.log(`  Unique ISPs:               ${report.infrastructureImpact.uniqueIsps}`);
  console.log(`  Unique Countries:          ${report.infrastructureImpact.uniqueCountries}`);
  console.log(`  Unique ASNs:               ${report.infrastructureImpact.uniqueAsns}`);

  // Top Providers
  if (report.infrastructureImpact.topProviders.length > 0) {
    console.log('\n  Top 5 Hosting Providers:');
    for (const provider of report.infrastructureImpact.topProviders.slice(0, 5)) {
      const bar = '█'.repeat(Math.ceil(provider.percentage / 2));
      console.log(`    ${provider.name.substring(0, 25).padEnd(25)} ${provider.count.toString().padStart(4)} (${provider.percentage.toFixed(1)}%) ${bar}`);
    }
  }

  // Top Countries
  if (report.infrastructureImpact.countryDistribution.length > 0) {
    console.log('\n  Top 5 Countries:');
    for (const country of report.infrastructureImpact.countryDistribution.slice(0, 5)) {
      const bar = '█'.repeat(Math.ceil(country.percentage / 2));
      console.log(`    ${country.country.substring(0, 25).padEnd(25)} ${country.count.toString().padStart(4)} (${country.percentage.toFixed(1)}%) ${bar}`);
    }
  }

  // Clusters
  if (report.clusters.length > 0) {
    console.log('\n🔍 TOP SUSPICIOUS CLUSTERS');
    console.log('─'.repeat(40));
    for (const cluster of report.clusters.slice(0, 5)) {
      console.log(`\n  ${cluster.id}`);
      console.log(`    Size: ${cluster.size} nodes`);
      console.log(`    Avg Score: ${cluster.avgScore.toFixed(3)}`);
      console.log(`    Type: ${cluster.clusterType}`);
      if (cluster.primaryIsp) console.log(`    Primary ISP: ${cluster.primaryIsp}`);
      if (cluster.primaryCountry) console.log(`    Primary Country: ${cluster.primaryCountry}`);
      console.log(`    IP Ranges: ${cluster.ipRanges.slice(0, 3).join(', ')}${cluster.ipRanges.length > 3 ? '...' : ''}`);
    }
  }

  // Top Suspicious Nodes
  console.log('\n⚠️  TOP 10 SUSPICIOUS NODES');
  console.log('─'.repeat(40));
  for (const node of report.topSuspicious.slice(0, 10)) {
    console.log(`  ${node.ip.padEnd(16)} Score: ${node.score.toFixed(3)} | ${node.reasons.slice(0, 3).join(', ')}`);
  }

  // IP Range Concerns
  if (report.infrastructureImpact.ipRangeConcentration.length > 0) {
    console.log('\n🔒 IP RANGE CONCENTRATION');
    console.log('─'.repeat(40));
    for (const range of report.infrastructureImpact.ipRangeConcentration.slice(0, 5)) {
      console.log(`  ${range.range.padEnd(20)} ${range.count} nodes (${range.percentage.toFixed(1)}%)`);
    }
  }

  console.log('\n' + '═'.repeat(65));
  console.log('Analysis complete. Check the generated reports for full details.');
  console.log('═'.repeat(65) + '\n');
}
