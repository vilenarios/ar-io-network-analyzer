/**
 * Main Arweave node network analyzer
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import type {
  ArweaveNode,
  ArweaveNodeAnalysis,
  ArweaveAnalyzerConfig,
  ArweaveNetworkReport,
  ArweaveClusterSummary,
  InfrastructureImpact,
  PeerEdge,
} from './arweave-types.js';
import { NodeCrawler, getDemoNodes } from './node-crawler.js';
import { PeerGraph } from './peer-graph.js';
import { batchGeoLocation, identifyCloudProvider } from '../utils/geo-location.js';
import { generateArweaveHTML } from './utils/arweave-html-generator.js';
import { printArweaveSummary } from './utils/arweave-display.js';

export class ArweaveNodeAnalyzer {
  private config: ArweaveAnalyzerConfig;
  private results: ArweaveNodeAnalysis[] = [];
  private graph!: PeerGraph;
  private betweenness: Map<string, number> = new Map();

  constructor(config: ArweaveAnalyzerConfig) {
    this.config = config;
  }

  async analyze(): Promise<void> {
    console.log('\nConfiguration:');
    console.log(`  Max Nodes: ${this.config.crawler.maxNodes}`);
    console.log(`  Concurrency: ${this.config.crawler.concurrency}`);
    console.log(`  Geographic Analysis: ${this.config.skipGeo ? 'Disabled' : 'Enabled'}`);
    console.log(`  Demo Mode: ${this.config.useDemoData ? 'Yes' : 'No'}\n`);

    try {
      // 1. Crawl network or use demo data
      console.log('🌐 Discovering Arweave nodes...\n');
      const crawlResult = this.config.useDemoData
        ? getDemoNodes()
        : await new NodeCrawler(this.config.crawler).crawl();

      console.log(`\n📊 Discovered ${crawlResult.nodes.size} nodes, ${crawlResult.edges.length} edges`);
      console.log(`   Responsive: ${crawlResult.stats.totalResponsive}`);
      console.log(`   Failed: ${crawlResult.stats.totalFailed}\n`);

      // Validate we have nodes to analyze
      if (crawlResult.nodes.size === 0) {
        console.error('❌ No nodes discovered. Check network connectivity or seed nodes.');
        return;
      }

      // 2. Build peer graph
      console.log('🔗 Building peer graph...');
      this.graph = new PeerGraph(crawlResult.nodes, crawlResult.edges);

      // 3. Calculate graph metrics
      console.log('📈 Calculating graph metrics...')
      this.betweenness = this.graph.calculateBetweennessCentrality();

      // 4. Batch geo lookup for ALL nodes (responsive and non-responsive)
      const nodeArray = Array.from(crawlResult.nodes.values());
      let geoData = new Map<string, any>();

      if (!this.config.skipGeo) {
        console.log('\n🌍 Looking up geographic data (batch mode)...');
        const allIps = nodeArray.map(n => n.ip);
        const uniqueIps = [...new Set(allIps)]; // Deduplicate IPs
        console.log(`   Fetching geo data for ${uniqueIps.length} unique IPs...`);

        const batchCount = Math.ceil(uniqueIps.length / 100);
        console.log(`   Processing ${batchCount} batch(es) of up to 100 IPs each...`);

        geoData = await batchGeoLocation(uniqueIps);
        console.log(`   Retrieved geo data for ${geoData.size} IPs`);
      }

      // 5. Analyze each node
      console.log('\n🔬 Analyzing nodes...');
      for (let i = 0; i < nodeArray.length; i++) {
        const node = nodeArray[i];
        if ((i + 1) % 100 === 0 || i === nodeArray.length - 1) {
          process.stdout.write(`\r[${i + 1}/${nodeArray.length}] Analyzing nodes...`);
        }

        const analysis = await this.analyzeNode(node, crawlResult.edges);

        // Apply geo data if available
        const nodeGeo = geoData.get(node.ip);
        if (nodeGeo) {
          analysis.country = nodeGeo.country;
          analysis.countryCode = nodeGeo.countryCode;
          analysis.region = nodeGeo.regionName || nodeGeo.region;
          analysis.city = nodeGeo.city;
          analysis.latitude = nodeGeo.lat;
          analysis.longitude = nodeGeo.lon;
          analysis.timezone = nodeGeo.timezone;
          analysis.isp = nodeGeo.isp;
          analysis.asn = nodeGeo.as;
          analysis.asnOrg = nodeGeo.org;
          analysis.hosting = nodeGeo.hosting;
        }

        this.results.push(analysis);
      }
      console.log('\n');

      // 6. Detect clusters
      console.log('🔍 Detecting centralization patterns...');
      this.detectClusters();

      // 7. Calculate scores
      console.log('📊 Calculating centralization scores...');
      this.calculateScores();

      // 8. Generate reports
      await this.generateReports(crawlResult.stats.crawlDuration);
    } catch (error) {
      console.error('\n❌ Error:', error);
      throw error;
    }
  }

  private async analyzeNode(node: ArweaveNode, edges: PeerEdge[]): Promise<ArweaveNodeAnalysis> {
    // Calculate IP ranges
    const ipParts = node.ip.split('.');
    const ipRange24 =
      ipParts.length === 4 ? `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24` : 'unknown';
    const ipRange16 = ipParts.length === 4 ? `${ipParts[0]}.${ipParts[1]}.0.0/16` : 'unknown';

    // Get graph metrics
    const degree = this.graph.getDegree(node.address);
    const inDegree = this.graph.getInDegree(node.address);
    const outDegree = this.graph.getOutDegree(node.address);
    const betweennessCentrality = this.betweenness.get(node.address) || 0;
    const clusteringCoefficient = this.graph.calculateClusteringCoefficient(node.address);

    return {
      ...node,
      ipRange24,
      ipRange16,

      // Scores (calculated later)
      geographicCentralization: 0,
      networkCentralization: 0,
      infrastructureCentralization: 0,
      technicalCentralization: 0,
      overallCentralization: 0,

      // Clustering
      clusterId: '',
      clusterSize: 0,
      suspicionNotes: [],

      // Graph metrics
      degree,
      inDegree,
      outDegree,
      betweennessCentrality,
      clusteringCoefficient,
    };
  }

  private detectClusters(): void {
    let clusterId = 1;

    // Phase 1: IP Range Clustering (/24)
    const ip24Groups = this.groupBy(this.results, (n) => n.ipRange24);
    for (const [range, nodes] of ip24Groups) {
      if (nodes.length >= 3 && range !== 'unknown') {
        const id = `ip24-${clusterId++}`;
        nodes.forEach((n) => {
          n.clusterId = id;
          n.clusterSize = nodes.length;
          if (!n.suspicionNotes.includes('same_ip_range_24')) {
            n.suspicionNotes.push('same_ip_range_24');
          }
        });
        console.log(`  Cluster ${id}: ${nodes.length} nodes in ${range}`);
      }
    }

    // Phase 2: ISP + City clustering (for unclustered nodes)
    const unclustered = this.results.filter((n) => !n.clusterId && n.isp && n.city);
    const ispCityGroups = this.groupBy(unclustered, (n) => `${n.isp}|${n.city}|${n.countryCode}`);
    for (const [key, nodes] of ispCityGroups) {
      if (nodes.length >= 5) {
        const id = `infra-${clusterId++}`;
        nodes.forEach((n) => {
          n.clusterId = id;
          n.clusterSize = nodes.length;
          if (!n.suspicionNotes.includes('isp_city_concentration')) {
            n.suspicionNotes.push('isp_city_concentration');
          }
        });
        const [isp, city] = key.split('|');
        console.log(`  Cluster ${id}: ${nodes.length} nodes at ${isp} in ${city}`);
      }
    }

  }

  private calculateScores(): void {
    const totalNodes = this.results.length;
    if (totalNodes === 0) return;

    // Pre-calculate group counts
    const cityCountMap = new Map<string, number>();
    const ispCountMap = new Map<string, number>();
    const asnCountMap = new Map<string, number>();
    const ip24CountMap = new Map<string, number>();
    const ip16CountMap = new Map<string, number>();
    const providerCountMap = new Map<string, number>();

    for (const node of this.results) {
      const cityKey = `${node.city}|${node.countryCode}`;
      cityCountMap.set(cityKey, (cityCountMap.get(cityKey) || 0) + 1);

      if (node.isp) {
        ispCountMap.set(node.isp, (ispCountMap.get(node.isp) || 0) + 1);
      }
      if (node.asn) {
        asnCountMap.set(node.asn, (asnCountMap.get(node.asn) || 0) + 1);
      }
      ip24CountMap.set(node.ipRange24, (ip24CountMap.get(node.ipRange24) || 0) + 1);
      ip16CountMap.set(node.ipRange16, (ip16CountMap.get(node.ipRange16) || 0) + 1);

      const provider = identifyCloudProvider(node.isp, node.asnOrg);
      if (provider) {
        providerCountMap.set(provider, (providerCountMap.get(provider) || 0) + 1);
      }
    }

    // Pre-group nodes by cluster for O(1) lookups in calculateTechnicalScore
    const clusterNodesMap = new Map<string, ArweaveNodeAnalysis[]>();
    for (const node of this.results) {
      if (node.clusterId) {
        if (!clusterNodesMap.has(node.clusterId)) {
          clusterNodesMap.set(node.clusterId, []);
        }
        clusterNodesMap.get(node.clusterId)!.push(node);
      }
    }

    for (const node of this.results) {
      // Geographic centralization (30%)
      node.geographicCentralization = this.calculateGeographicScore(
        node,
        cityCountMap,
        ispCountMap,
        asnCountMap
      );

      // Network centralization (30%)
      node.networkCentralization = this.calculateNetworkScore(node, ip24CountMap, ip16CountMap);

      // Infrastructure centralization (25%)
      node.infrastructureCentralization = this.calculateInfrastructureScore(
        node,
        providerCountMap,
        totalNodes
      );

      // Technical centralization (15%)
      node.technicalCentralization = this.calculateTechnicalScore(node, clusterNodesMap);

      // Overall score (weighted average)
      node.overallCentralization = Math.min(
        node.geographicCentralization * 0.3 +
          node.networkCentralization * 0.3 +
          node.infrastructureCentralization * 0.25 +
          node.technicalCentralization * 0.15,
        1
      );
    }
  }

  private calculateGeographicScore(
    node: ArweaveNodeAnalysis,
    cityCountMap: Map<string, number>,
    ispCountMap: Map<string, number>,
    asnCountMap: Map<string, number>
  ): number {
    let score = 0;

    // City concentration
    const cityKey = `${node.city}|${node.countryCode}`;
    const sameCity = cityCountMap.get(cityKey) || 0;
    if (sameCity >= 5) {
      score += Math.min(0.3 + (sameCity - 5) * 0.05, 0.6);
      if (!node.suspicionNotes.includes('geographic_concentration')) {
        node.suspicionNotes.push('geographic_concentration');
      }
    }

    // ISP concentration
    const sameIsp = ispCountMap.get(node.isp || '') || 0;
    if (sameIsp >= 10) {
      score += Math.min(0.2 + (sameIsp - 10) * 0.03, 0.5);
      if (!node.suspicionNotes.includes('isp_concentration')) {
        node.suspicionNotes.push('isp_concentration');
      }
    }

    // ASN concentration
    const sameAsn = asnCountMap.get(node.asn || '') || 0;
    if (sameAsn >= 15) {
      score += Math.min(0.2 + (sameAsn - 15) * 0.02, 0.4);
      if (!node.suspicionNotes.includes('asn_concentration')) {
        node.suspicionNotes.push('asn_concentration');
      }
    }

    // Datacenter penalty
    if (node.hosting) {
      score += 0.1;
      if (!node.suspicionNotes.includes('datacenter_hosting')) {
        node.suspicionNotes.push('datacenter_hosting');
      }
    }

    return Math.min(score, 1.0);
  }

  private calculateNetworkScore(
    node: ArweaveNodeAnalysis,
    ip24CountMap: Map<string, number>,
    ip16CountMap: Map<string, number>
  ): number {
    let score = 0;

    // /24 range concentration (very suspicious)
    const same24 = ip24CountMap.get(node.ipRange24) || 0;
    if (same24 >= 3) {
      score += Math.min(0.4 + (same24 - 3) * 0.15, 0.9);
      if (!node.suspicionNotes.includes('same_ip_range_24')) {
        node.suspicionNotes.push('same_ip_range_24');
      }
    }

    // /16 range concentration
    const same16 = ip16CountMap.get(node.ipRange16) || 0;
    if (same16 >= 10) {
      score += Math.min(0.2 + (same16 - 10) * 0.05, 0.5);
      if (!node.suspicionNotes.includes('same_ip_range_16')) {
        node.suspicionNotes.push('same_ip_range_16');
      }
    }

    return Math.min(score, 1.0);
  }

  private calculateInfrastructureScore(
    node: ArweaveNodeAnalysis,
    providerCountMap: Map<string, number>,
    totalNodes: number
  ): number {
    let score = 0;

    const provider = identifyCloudProvider(node.isp, node.asnOrg);
    if (provider) {
      const sameProvider = providerCountMap.get(provider) || 0;
      const percentage = sameProvider / totalNodes;

      if (percentage > 0.2) {
        score += 0.5;
        if (!node.suspicionNotes.includes('provider_dominance')) {
          node.suspicionNotes.push('provider_dominance');
        }
      } else if (percentage > 0.1) {
        score += 0.3;
      } else if (percentage > 0.05) {
        score += 0.15;
      }
    }

    // Additional datacenter clustering
    if (node.hosting && node.clusterId) {
      score += 0.2;
    }

    return Math.min(score, 1.0);
  }

  private calculateTechnicalScore(
    node: ArweaveNodeAnalysis,
    clusterNodesMap: Map<string, ArweaveNodeAnalysis[]>
  ): number {
    let score = 0;

    // High betweenness centrality could indicate important bridge node
    // Not necessarily suspicious, but worth noting
    if (node.betweennessCentrality && node.betweennessCentrality > 0.1) {
      // Just note it, don't penalize
    }

    // Very low clustering coefficient in a cluster might be suspicious
    if (node.clusterId && node.clusteringCoefficient !== undefined) {
      if (node.clusteringCoefficient > 0.8) {
        // High internal connectivity in cluster
        score += 0.2;
      }
    }

    // Version uniformity within cluster (O(1) lookup instead of O(n) filter)
    if (node.clusterId) {
      const clusterNodes = clusterNodesMap.get(node.clusterId) || [];
      const versions = clusterNodes.map((n) => n.version).filter(Boolean);
      const uniqueVersions = new Set(versions);
      if (uniqueVersions.size === 1 && versions.length >= 3) {
        score += 0.1;
        if (!node.suspicionNotes.includes('identical_version')) {
          node.suspicionNotes.push('identical_version');
        }
      }
    }

    return Math.min(score, 1.0);
  }

  private async generateReports(crawlDuration: number): Promise<void> {
    // Sort by centralization score
    this.results.sort((a, b) => b.overallCentralization - a.overallCentralization);

    // Generate summary
    const summary = this.generateSummary(crawlDuration);

    // Ensure output directory exists
    if (!existsSync(this.config.outputDir)) {
      mkdirSync(this.config.outputDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split('T')[0];

    // Generate CSV
    const csvFilename = `${this.config.outputDir}/arweave-nodes-${dateStr}.csv`;
    this.generateCSV(csvFilename);
    console.log(`\n✅ CSV report saved to ${csvFilename}`);

    // Generate JSON
    const jsonFilename = `${this.config.outputDir}/arweave-summary-${dateStr}.json`;
    writeFileSync(jsonFilename, JSON.stringify(summary, null, 2));
    console.log(`📋 JSON summary saved to ${jsonFilename}`);

    // Generate HTML
    const htmlFilename = `${this.config.outputDir}/arweave-report-${dateStr}.html`;
    const csvBasename = `arweave-nodes-${dateStr}.csv`;
    const jsonBasename = `arweave-summary-${dateStr}.json`;
    const htmlContent = generateArweaveHTML(summary, this.results, this.graph, csvBasename, jsonBasename);
    writeFileSync(htmlFilename, htmlContent);
    console.log(`🌐 Interactive report saved to ${htmlFilename}`);

    // Print console summary
    printArweaveSummary(summary);
  }

  private generateSummary(crawlDuration: number): ArweaveNetworkReport {
    const responsiveNodes = this.results.filter((n) => n.isResponsive);
    const bidirectionalCount = this.graph.getEdges().filter((e) => e.bidirectional).length / 2;

    // Cluster summaries
    const clusterGroups = this.groupBy(
      this.results.filter((n) => n.clusterId),
      (n) => n.clusterId
    );
    const clusters: ArweaveClusterSummary[] = Array.from(clusterGroups.entries()).map(
      ([id, nodes]) => {
        const ipRanges = [...new Set(nodes.map((n) => n.ipRange24))];
        const ispCounts = new Map<string, number>();
        const countryCounts = new Map<string, number>();
        nodes.forEach((n) => {
          if (n.isp) ispCounts.set(n.isp, (ispCounts.get(n.isp) || 0) + 1);
          if (n.country) countryCounts.set(n.country, (countryCounts.get(n.country) || 0) + 1);
        });

        let primaryIsp: string | undefined;
        let maxIspCount = 0;
        for (const [isp, count] of ispCounts) {
          if (count > maxIspCount) {
            maxIspCount = count;
            primaryIsp = isp;
          }
        }

        let primaryCountry: string | undefined;
        let maxCountryCount = 0;
        for (const [country, count] of countryCounts) {
          if (count > maxCountryCount) {
            maxCountryCount = count;
            primaryCountry = country;
          }
        }

        return {
          id,
          size: nodes.length,
          avgScore: nodes.reduce((sum, n) => sum + n.overallCentralization, 0) / nodes.length,
          nodes: nodes.map((n) => n.address),
          primaryIsp,
          primaryCountry,
          ipRanges,
          clusterType: id.startsWith('ip24')
            ? 'network'
            : id.startsWith('infra')
              ? 'infrastructure'
              : 'mixed',
        };
      }
    );

    // Infrastructure impact
    const infrastructureImpact = this.calculateInfrastructureImpact();

    // Peer counts
    const peerCounts = responsiveNodes.map((n) => n.peers || 0).sort((a, b) => a - b);
    const avgPeerCount = peerCounts.reduce((a, b) => a + b, 0) / (peerCounts.length || 1);
    const medianPeerCount = peerCounts[Math.floor(peerCounts.length / 2)] || 0;

    return {
      timestamp: new Date().toISOString(),
      crawlDuration,

      totalNodesDiscovered: this.results.length,
      totalNodesResponsive: responsiveNodes.length,
      totalNodesFailed: this.results.length - responsiveNodes.length,
      totalEdges: this.graph.getEdgeCount(),
      bidirectionalEdges: bidirectionalCount,

      clusteredNodes: this.results.filter((n) => n.clusterId).length,
      highCentralization: this.results.filter((n) => n.overallCentralization > 0.7).length,
      mediumCentralization: this.results.filter(
        (n) => n.overallCentralization > 0.4 && n.overallCentralization <= 0.7
      ).length,
      lowCentralization: this.results.filter((n) => n.overallCentralization <= 0.4).length,

      avgPeerCount,
      medianPeerCount,
      networkDensity: this.graph.calculateDensity(),
      avgClusteringCoefficient: this.graph.calculateAvgClusteringCoefficient(),
      componentCount: this.graph.findConnectedComponents().length,

      clusters: clusters.sort((a, b) => b.avgScore - a.avgScore),
      topSuspicious: this.results.slice(0, 100).map((n) => ({
        address: n.address,
        ip: n.ip,
        score: n.overallCentralization,
        reasons: n.suspicionNotes,
        isp: n.isp,
        country: n.country,
      })),

      infrastructureImpact,
    };
  }

  private calculateInfrastructureImpact(): InfrastructureImpact {
    // Separate responsive and all nodes
    const responsiveNodes = this.results.filter((n) => n.isResponsive);
    const allNodes = this.results;

    // Helper to calculate stats for a given node set
    const calculateStats = (nodes: typeof this.results, totalCount: number) => {
      const datacenterNodes = nodes.filter((n) => n.hosting === true);

      // ISP distribution
      const ispGroups = this.groupBy(
        nodes.filter((n) => n.isp),
        (n) => n.isp!
      );
      const topProviders = Array.from(ispGroups.entries())
        .map(([name, nodeList]) => ({
          name,
          count: nodeList.length,
          percentage: totalCount > 0 ? (nodeList.length / totalCount) * 100 : 0,
          nodes: nodeList.map((n) => n.address),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // Country distribution
      const countryGroups = this.groupBy(
        nodes.filter((n) => n.country),
        (n) => n.country!
      );
      const countryDistribution = Array.from(countryGroups.entries())
        .map(([country, nodeList]) => ({
          country,
          countryCode: nodeList[0].countryCode || '',
          count: nodeList.length,
          percentage: totalCount > 0 ? (nodeList.length / totalCount) * 100 : 0,
        }))
        .sort((a, b) => b.count - a.count);

      // IP range concentration
      const ip24Groups = this.groupBy(
        nodes.filter((n) => n.ipRange24 !== 'unknown'),
        (n) => n.ipRange24
      );
      const ipRangeConcentration = Array.from(ip24Groups.entries())
        .filter(([_, nodeList]) => nodeList.length >= 3)
        .map(([range, nodeList]) => ({
          range,
          count: nodeList.length,
          percentage: totalCount > 0 ? (nodeList.length / totalCount) * 100 : 0,
          nodes: nodeList.map((n) => n.address),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      return {
        totalDatacenterHosted: datacenterNodes.length,
        datacenterPercentage: totalCount > 0 ? (datacenterNodes.length / totalCount) * 100 : 0,
        topProviders,
        countryDistribution,
        ipRangeConcentration,
        uniqueIsps: ispGroups.size,
        uniqueCountries: countryGroups.size,
        uniqueAsns: new Set(nodes.map((n) => n.asn).filter(Boolean)).size,
      };
    };

    // Calculate stats for responsive nodes (primary view)
    const responsiveStats = calculateStats(responsiveNodes, responsiveNodes.length);
    // Calculate stats for all nodes (toggle view)
    const allNodesStats = calculateStats(allNodes, allNodes.length);

    return {
      ...responsiveStats,
      allNodes: allNodesStats,
      totalNodesDiscovered: allNodes.length,
      totalNodesResponsive: responsiveNodes.length,
    };
  }

  private generateCSV(filename: string): void {
    const headers = [
      'Address',
      'IP',
      'Port',
      'Responsive',
      'Version',
      'Height',
      'Peers',
      'Country',
      'City',
      'ISP',
      'ASN',
      'Hosting',
      'IP Range /24',
      'IP Range /16',
      'Degree',
      'In-Degree',
      'Out-Degree',
      'Betweenness',
      'Clustering Coef',
      'Cluster ID',
      'Cluster Size',
      'Geographic Score',
      'Network Score',
      'Infrastructure Score',
      'Technical Score',
      'Overall Score',
      'Suspicion Notes',
    ];

    const rows = this.results.map((n) => [
      n.address,
      n.ip,
      n.port,
      n.isResponsive,
      n.version || '',
      n.height || '',
      n.peers || '',
      n.country || '',
      n.city || '',
      n.isp || '',
      n.asn || '',
      n.hosting || '',
      n.ipRange24,
      n.ipRange16,
      n.degree,
      n.inDegree,
      n.outDegree,
      n.betweennessCentrality?.toFixed(4) || '',
      n.clusteringCoefficient?.toFixed(4) || '',
      n.clusterId || '',
      n.clusterSize || '',
      n.geographicCentralization.toFixed(3),
      n.networkCentralization.toFixed(3),
      n.infrastructureCentralization.toFixed(3),
      n.technicalCentralization.toFixed(3),
      n.overallCentralization.toFixed(3),
      n.suspicionNotes.join('; '),
    ]);

    const csv =
      headers.join(',') +
      '\n' +
      rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');

    writeFileSync(filename, csv);
  }

  private groupBy<T, K>(array: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const map = new Map<K, T[]>();
    for (const item of array) {
      const key = keyFn(item);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(item);
    }
    return map;
  }
}
