/**
 * Type definitions for the Arweave node network analyzer
 */

// Core node representation from discovery
export interface ArweaveNode {
  ip: string;
  port: number;
  address: string; // Combined "ip:port" identifier

  // From /info endpoint
  version?: number;
  release?: number;
  height?: number;
  network?: string;
  blocks?: number;
  peers?: number; // Number of peers this node reports
  queueLength?: number;
  nodeStateLatency?: number;

  // Discovery metadata
  discoveredAt: number;
  discoveredFrom?: string; // Which node reported this peer
  responseTime?: number;
  isResponsive: boolean;
  lastSeen?: number;

  // Computed from crawl
  inboundPeers: string[]; // Nodes that list this as a peer
  outboundPeers: string[]; // Nodes this lists as peers
}

// Geographic and infrastructure data
export interface NodeGeoData {
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  asn?: string;
  asnOrg?: string;
  hosting?: boolean;
}

// Full node analysis result
export interface ArweaveNodeAnalysis extends ArweaveNode, NodeGeoData {
  // IP range analysis
  ipRange24: string; // /24 range (e.g., "159.65.213.0/24")
  ipRange16: string; // /16 range (e.g., "159.65.0.0/16")

  // Centralization scores (0-1)
  geographicCentralization: number;
  networkCentralization: number;
  infrastructureCentralization: number;
  technicalCentralization: number;
  overallCentralization: number;

  // Clustering
  clusterId: string;
  clusterSize: number;
  suspicionNotes: string[];

  // Graph metrics
  degree: number; // Total connections
  inDegree: number; // Inbound connections
  outDegree: number; // Outbound connections
  betweennessCentrality?: number;
  clusteringCoefficient?: number;
}

// Peer graph edge
export interface PeerEdge {
  source: string; // Node address reporting the peer
  target: string; // Peer address being reported
  discoveredAt: number;
  bidirectional: boolean;
}

// Crawler configuration
export interface CrawlerConfig {
  seedNodes: string[];
  maxNodes: number;
  timeout: number;
  concurrency: number;
  delayBetweenRequests: number;
  retries: number;
}

// Analyzer configuration
export interface ArweaveAnalyzerConfig {
  crawler: CrawlerConfig;
  skipGeo: boolean;
  outputDir: string;
  useDemoData: boolean;
}

// Crawl result
export interface CrawlResult {
  nodes: Map<string, ArweaveNode>;
  edges: PeerEdge[];
  stats: CrawlStats;
}

export interface CrawlStats {
  totalDiscovered: number;
  totalResponsive: number;
  totalFailed: number;
  totalEdges: number;
  crawlDuration: number;
}

// Cluster summary
export interface ArweaveClusterSummary {
  id: string;
  size: number;
  avgScore: number;
  nodes: string[];
  primaryIsp?: string;
  primaryCountry?: string;
  ipRanges: string[];
  clusterType: 'geographic' | 'network' | 'infrastructure' | 'mixed';
}

// Final report structure
export interface ArweaveNetworkReport {
  timestamp: string;
  crawlDuration: number;

  // Discovery stats
  totalNodesDiscovered: number;
  totalNodesResponsive: number;
  totalNodesFailed: number;
  totalEdges: number;
  bidirectionalEdges: number;

  // Centralization metrics
  clusteredNodes: number;
  highCentralization: number;
  mediumCentralization: number;
  lowCentralization: number;

  // Network health
  avgPeerCount: number;
  medianPeerCount: number;
  networkDensity: number;
  avgClusteringCoefficient: number;
  componentCount: number;

  // Analysis results
  clusters: ArweaveClusterSummary[];
  topSuspicious: SuspiciousNode[];

  // Infrastructure breakdown
  infrastructureImpact: InfrastructureImpact;
}

export interface SuspiciousNode {
  address: string;
  ip: string;
  score: number;
  reasons: string[];
  isp?: string;
  country?: string;
}

export interface InfrastructureImpact {
  totalDatacenterHosted: number;
  datacenterPercentage: number;
  topProviders: ProviderInfo[];
  countryDistribution: CountryInfo[];
  ipRangeConcentration: IpRangeInfo[];
  uniqueIsps: number;
  uniqueCountries: number;
  uniqueAsns: number;
}

export interface ProviderInfo {
  name: string;
  count: number;
  percentage: number;
  nodes: string[];
}

export interface CountryInfo {
  country: string;
  countryCode: string;
  count: number;
  percentage: number;
}

export interface IpRangeInfo {
  range: string;
  count: number;
  percentage: number;
  nodes: string[];
}

// Node info response from /info endpoint
export interface ArweaveNodeInfo {
  network: string;
  version: number;
  release: number;
  height: number;
  current: string;
  blocks: number;
  peers: number;
  queue_length: number;
  node_state_latency: number;
}
