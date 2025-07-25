/**
 * Display and formatting utilities
 */

import type { CentralizationReport } from '../types.js';

export function displayBanner() {
  console.log('\n' + '='.repeat(70));
  console.log('                 AR.IO Gateway Centralization Analyzer');
  console.log('='.repeat(70) + '\n');
  console.log('🔍 Analyzing gateway patterns to detect potential centralization...\n');
}

export function printSummary(report: CentralizationReport, includePerformance: boolean) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 CENTRALIZATION ANALYSIS SUMMARY');
  console.log('='.repeat(70) + '\n');
  
  // Overall stats
  const { totalGateways, clusteredGateways, highCentralization } = report;
  const mediumCentralization = report.topSuspicious.filter(
    g => g.score > 0.4 && g.score <= 0.7
  ).length;
  
  console.log('📈 OVERALL STATISTICS:');
  console.log(`   Total Gateways: ${totalGateways}`);
  console.log(`   Clustered Gateways: ${clusteredGateways} (${(clusteredGateways/totalGateways*100).toFixed(1)}%)`);
  console.log(`   High Centralization (>0.7): ${highCentralization} gateways`);
  console.log(`   Medium Centralization (0.4-0.7): ${mediumCentralization} gateways`);
  
  // Scoring breakdown
  console.log('\n🎯 SCORING BREAKDOWN:');
  console.log('   Domain Patterns: 25% weight');
  console.log('   Geographic Distribution: 25% weight');
  console.log('   Network Similarity: 15% weight');
  console.log('   Temporal Patterns: 15% weight');
  console.log('   Stake Patterns: 10% weight');
  console.log('   Technical Similarity: 10% weight' + (includePerformance ? '' : ' (disabled)'));
  
  // Pattern analysis
  const patterns = new Map<string, number>();
  report.clusters.forEach(cluster => {
    if (cluster.pattern !== 'unique') {
      patterns.set(cluster.pattern, (patterns.get(cluster.pattern) || 0) + cluster.size);
    }
  });
  
  if (patterns.size > 0) {
    console.log('\n🔍 PATTERN ANALYSIS:');
    Array.from(patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([pattern, count]) => {
        console.log(`   ${pattern}: ${count} gateways`);
      });
  }
  
  // Top centralized clusters
  if (report.clusters.length > 0) {
    console.log('\n🚨 TOP CENTRALIZED CLUSTERS:');
    
    const topClusters = report.clusters.slice(0, 5);
    topClusters.forEach((cluster, index) => {
      console.log(`\n   ${index + 1}. Cluster: ${cluster.id}`);
      console.log(`      Base Domain: ${cluster.baseDomain}`);
      console.log(`      Pattern: ${cluster.pattern}`);
      console.log(`      Size: ${cluster.size} gateways`);
      console.log(`      Avg Centralization Score: ${cluster.avgScore.toFixed(3)}`);
      if (cluster.totalRewards && cluster.totalRewards > 0) {
        console.log(`      Est. ARIO Rewards: ${Math.round(cluster.totalRewards / 1e6).toLocaleString()}`);
      }
      console.log(`      Gateways: ${cluster.gateways.slice(0, 3).join(', ')}${cluster.size > 3 ? ` (+${cluster.size - 3} more)` : ''}`);
    });
  }
  
  // Economic impact section
  if (report.economicImpact) {
    console.log('\n💰 ECONOMIC IMPACT (ESTIMATED):');
    const rewardPerGateway = Math.round(report.economicImpact.rewardPerGateway / 1e6);
    const totalMio = Math.round(report.economicImpact.totalDistributedRewards / 1e6);
    const centralizedMio = Math.round(report.economicImpact.topCentralizedRewards / 1e6);
    
    console.log(`   Per Gateway Reward: ${rewardPerGateway.toLocaleString()} ARIO per epoch`);
    console.log(`   Total Epoch Rewards: ${totalMio.toLocaleString()} ARIO`);
    console.log(`   To Centralized Clusters: ${centralizedMio.toLocaleString()} ARIO (${report.economicImpact.topCentralizedPercentage.toFixed(1)}%)`);
    
    if (report.economicImpact.rewardsByCluster.length > 0) {
      console.log('\n   Top Rewarded Clusters:');
      report.economicImpact.rewardsByCluster.slice(0, 5).forEach((cluster, idx) => {
        const rewardsMio = Math.round(cluster.clusterRewards / 1e6);
        console.log(`   ${idx + 1}. ${cluster.clusterId}: ${rewardsMio.toLocaleString()} ARIO (${cluster.percentageOfTotal.toFixed(1)}%) - ${cluster.gatewayCount} gateways`);
      });
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('📄 Output Files:');
  console.log('  💾 CSV file - Detailed analysis of all gateways');
  console.log('  📊 JSON file - Machine-readable summary');
  console.log('  🌐 HTML file - Interactive visual report (open in browser)');
  console.log('='.repeat(70) + '\n');
}