/**
 * Type definitions for the gateway centralization analyzer
 */

export interface Gateway {
  fqdn: string;
  wallet: string;
  stake: number;
  status: string;
  startTimestamp?: number;
  endTimestamp?: number;
  properties?: string;
  note?: string;
  settings?: {
    fqdn: string;
    port?: number;
    protocol?: string;
    properties?: string;
    note?: string;
  };
  stats?: {
    prescribedEpochCount?: number;
    observedEpochCount?: number;
    totalEpochCount?: number;
    passedEpochCount?: number;
    failedEpochCount?: number;
    failedConsecutiveEpochs?: number;
    passedConsecutiveEpochs?: number;
  };
}

export interface GatewayAnalysis {
  // Basic info
  fqdn: string;
  wallet: string;
  stake: number;
  status: string;
  
  // Domain analysis
  baseDomain: string;
  domainPattern: string;
  domainGroupSize: number;
  domainAge?: number;
  
  // Network analysis
  ipAddress: string;
  ipRange: string;
  asn?: string;
  asnOrg?: string;
  datacenter?: string;
  
  // Geographic analysis
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  hosting?: boolean;
  
  // Certificate analysis
  certIssuer?: string;
  certIssueDate?: Date;
  certExpiryDate?: Date;
  
  // Performance fingerprint
  responseTime?: number;
  serverHeader?: string;
  httpVersion?: string;
  supportedCompression?: string[];
  
  // Temporal analysis
  registrationTimestamp?: number;
  registrationProximityScore?: number;
  
  // Centralization scores
  domainCentralization: number;
  networkCentralization: number;
  stakeCentralization: number;
  temporalCentralization: number;
  technicalCentralization: number;
  geographicCentralization: number;
  overallCentralization: number;
  
  // Clustering
  clusterId: string;
  clusterSize: number;
  clusterRole: 'primary' | 'secondary';
  suspicionNotes: string[];
}

export interface TechnicalFingerprint {
  serverHeader?: string;
  poweredBy?: string;
  httpVersion: string;
  tlsVersion?: string;
  tlsCiphers?: string[];
  acceptsCompression: string[];
  responseHeaders: Map<string, string>;
  responseTime: number;
  certInfo?: {
    issuer: string;
    issued: Date;
    expires: Date;
    subject: string;
  };
}

export interface CentralizationReport {
  timestamp: string;
  totalGateways: number;
  clusteredGateways: number;
  highCentralization: number;
  clusters: ClusterSummary[];
  topSuspicious: SuspiciousGateway[];
  economicImpact?: {
    totalDistributedRewards: number;
    rewardPerGateway: number;
    rewardsByCluster: Array<{
      clusterId: string;
      clusterRewards: number;
      gatewayCount: number;
      percentageOfTotal: number;
    }>;
    topCentralizedRewards: number;
    topCentralizedPercentage: number;
  };
}

export interface ClusterSummary {
  id: string;
  size: number;
  avgScore: number;
  baseDomain: string;
  pattern: string;
  gateways: string[];
  wallets?: string[];
  totalRewards?: number;
}

export interface SuspiciousGateway {
  fqdn: string;
  score: number;
  reasons: string[];
}

export interface AnalyzerConfig {
  processId: string;
  analyzePerformance: boolean;
  useDemoData: boolean;
  minStake: number;
  aoConfig?: {
    CU_URL?: string;
    MU_URL?: string;
    GATEWAY_URL?: string;
    GRAPHQL_URL?: string;
  };
}