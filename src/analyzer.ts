/**
 * Main analyzer class for gateway centralization detection
 */

import { resolve4 } from 'dns/promises';
import * as https from 'https';
import * as tls from 'tls';
import type {
  Gateway,
  GatewayAnalysis,
  TechnicalFingerprint,
  AnalyzerConfig,
  CentralizationReport,
  ClusterSummary,
  InfrastructureImpact
} from './types.js';
import { fetchGatewaysFromNetwork, getDemoGateways, fetchDistributions } from './data/gateway-fetcher.js';
import { generateCSV, generateJSON } from './utils/report-generator.js';
import { generateHTMLReport } from './utils/html-generator.js';
import { printSummary } from './utils/display.js';
import { batchGeoLocation } from './utils/geo-location.js';

export class GatewayCentralizationAnalyzer {
  private config: AnalyzerConfig;
  private results: GatewayAnalysis[] = [];
  private technicalFingerprints = new Map<string, TechnicalFingerprint>();
  private distributionData: { rewards?: Record<string, number>; totalEligibleGatewayReward?: number; totalDistributedRewards?: number } | null = null;
  private totalGatewaysInNetwork = 0;

  constructor(config: AnalyzerConfig) {
    this.config = config;
  }
  
  async analyze() {
    console.log('Configuration:');
    console.log(`  Process ID: ${this.config.processId}`);
    console.log(`  Performance Analysis: ${this.config.analyzePerformance ? 'Enabled' : 'Disabled'}`);
    console.log(`  Geographic Analysis: ${process.env.SKIP_GEO ? 'Disabled' : 'Enabled'}`);
    console.log(`  Min Stake Threshold: ${this.config.minStake}`);
    console.log(`  DNS Concurrency: ${this.config.dnsConcurrency || 50}`);
    console.log(`  Fingerprint Concurrency: ${this.config.fingerprintConcurrency || 20}\n`);
    
    try {
      // 1. Fetch all gateways
      console.log('📡 Fetching gateways...\n');
      const { gateways, totalFetched } = this.config.useDemoData
        ? getDemoGateways()
        : await fetchGatewaysFromNetwork(this.config);

      this.totalGatewaysInNetwork = totalFetched;
      console.log(`📊 Found ${gateways.length} gateways to analyze (${totalFetched} total in network)\n`);
      
      // Fetch distribution data for economic analysis
      if (!this.config.useDemoData) {
        console.log('💰 Fetching reward distribution data...');
        this.distributionData = await fetchDistributions();
        if (this.distributionData) {
          // Check if it's a direct wallet mapping
          if (!this.distributionData.rewards && typeof this.distributionData === 'object') {
            // Might be direct wallet->reward mapping, wrap it
            const walletRewards = { ...this.distributionData } as Record<string, number>;
            const total = Object.values(walletRewards).reduce((sum: number, reward) => sum + (typeof reward === 'number' ? reward : 0), 0);
            this.distributionData = {
              rewards: walletRewards,
              totalDistributedRewards: total
            };
          }
          
          const rewardPerGateway = this.distributionData.totalEligibleGatewayReward || 0;
          if (rewardPerGateway > 0) {
            console.log(`  Reward per gateway: ${(rewardPerGateway / 1e6).toLocaleString()} ARIO`);
            console.log(`  Estimated total pool: ${(rewardPerGateway * gateways.length / 1e6).toLocaleString()} ARIO\n`);
          }
        }
      }
      
      // 2. Parallel DNS resolution
      console.log('🔍 Resolving DNS for all gateways (parallel)...');
      const dnsResults = await this.parallelDnsResolve(gateways);
      console.log(`   Resolved ${dnsResults.filter(r => r.ip !== 'resolution_failed').length}/${gateways.length} gateways`);

      // 3. Batch geo lookups
      let geoData = new Map<string, any>();
      if (!this.config.useDemoData && !process.env.SKIP_GEO) {
        console.log('\n🌍 Looking up geographic data (batch mode)...');
        const validIps = dnsResults
          .map(r => r.ip)
          .filter(ip => ip !== 'resolution_failed');
        const uniqueIps = [...new Set(validIps)];
        console.log(`   Fetching geo data for ${uniqueIps.length} unique IPs...`);

        const batchCount = Math.ceil(uniqueIps.length / 100);
        console.log(`   Processing ${batchCount} batch(es) of up to 100 IPs each...`);

        geoData = await batchGeoLocation(uniqueIps);
        console.log(`   Retrieved geo data for ${geoData.size} IPs`);
      }

      // 4. Parallel technical fingerprinting (if enabled)
      let fingerprintResults = new Map<string, TechnicalFingerprint>();
      if (this.config.analyzePerformance && !this.config.useDemoData) {
        console.log('\n🔧 Fetching technical fingerprints (parallel)...');
        fingerprintResults = await this.parallelFingerprintFetch(gateways);
        console.log(`   Retrieved fingerprints for ${fingerprintResults.size}/${gateways.length} gateways`);
      }

      // 5. Combine all data into analysis results
      console.log('\n🔬 Combining analysis data...');
      for (let i = 0; i < gateways.length; i++) {
        const gateway = gateways[i];
        if ((i + 1) % 100 === 0 || i === gateways.length - 1) {
          process.stdout.write(`\r[${i + 1}/${gateways.length}] Processing gateways...`);
        }

        try {
          const dnsResult = dnsResults[i];
          const analysis = this.buildAnalysis(gateway, dnsResult, geoData, fingerprintResults);
          this.results.push(analysis);
        } catch (error) {
          console.error(`\nError analyzing ${gateway.fqdn}:`, error);
        }
      }
      console.log('\n');
      
      // 6. Detect clusters and patterns
      console.log('🔗 Detecting centralization patterns...');
      this.detectClusters();

      // 7. Calculate temporal scores
      console.log('⏱️  Analyzing temporal patterns...');
      this.calculateTemporalScores();

      // 8. Calculate technical similarity
      if (this.config.analyzePerformance) {
        console.log('🔧 Analyzing technical fingerprints...');
        this.calculateTechnicalScores();
      }

      // 9. Calculate geographic centralization
      console.log('🌍 Analyzing geographic distribution...');
      this.calculateGeographicScores();

      // 10. Calculate final scores
      console.log('📈 Calculating final centralization scores...');
      this.calculateFinalScores();

      // 11. Generate outputs
      await this.generateReports();
      
    } catch (error) {
      console.error('\n❌ Error:', error);
      throw error;
    }
  }
  
  /**
   * Parallel DNS resolution with concurrency limit
   */
  private async parallelDnsResolve(gateways: Gateway[]): Promise<Array<{ fqdn: string; ip: string; ipRange: string }>> {
    const concurrency = this.config.dnsConcurrency || 50;
    const results: Array<{ fqdn: string; ip: string; ipRange: string }> = [];
    let completed = 0;

    // Worker function
    const resolveDns = async (gateway: Gateway): Promise<{ fqdn: string; ip: string; ipRange: string }> => {
      try {
        const addresses = await resolve4(gateway.fqdn);
        const ip = addresses[0];
        const ipParts = ip.split('.');
        const ipRange = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;
        return { fqdn: gateway.fqdn, ip, ipRange };
      } catch {
        return { fqdn: gateway.fqdn, ip: 'resolution_failed', ipRange: 'unknown' };
      }
    };

    // Process in batches with concurrency limit
    for (let i = 0; i < gateways.length; i += concurrency) {
      const batch = gateways.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(resolveDns));
      results.push(...batchResults);
      completed += batch.length;
      process.stdout.write(`\r   [${completed}/${gateways.length}] Resolving DNS...`);
    }
    process.stdout.write('\n');

    return results;
  }

  /**
   * Parallel technical fingerprint fetching with concurrency limit
   */
  private async parallelFingerprintFetch(gateways: Gateway[]): Promise<Map<string, TechnicalFingerprint>> {
    const concurrency = this.config.fingerprintConcurrency || 20;
    const results = new Map<string, TechnicalFingerprint>();
    let completed = 0;

    // Process in batches with concurrency limit
    for (let i = 0; i < gateways.length; i += concurrency) {
      const batch = gateways.slice(i, i + concurrency);
      const batchPromises = batch.map(async (gateway) => {
        const fingerprint = await this.getTechnicalFingerprint(gateway.fqdn);
        return { fqdn: gateway.fqdn, fingerprint };
      });

      const batchResults = await Promise.all(batchPromises);
      for (const { fqdn, fingerprint } of batchResults) {
        if (fingerprint) {
          results.set(fqdn, fingerprint);
          this.technicalFingerprints.set(fqdn, fingerprint);
        }
      }

      completed += batch.length;
      process.stdout.write(`\r   [${completed}/${gateways.length}] Fetching fingerprints...`);
    }
    process.stdout.write('\n');

    return results;
  }

  /**
   * Build analysis from pre-fetched data
   */
  private buildAnalysis(
    gateway: Gateway,
    dnsResult: { fqdn: string; ip: string; ipRange: string },
    geoData: Map<string, any>,
    fingerprintResults: Map<string, TechnicalFingerprint>
  ): GatewayAnalysis {
    // Domain analysis
    const domainInfo = this.analyzeDomain(gateway.fqdn);

    // Apply geo data if available
    let geoInfo = {};
    const nodeGeo = geoData.get(dnsResult.ip);
    if (nodeGeo) {
      geoInfo = {
        country: nodeGeo.country,
        countryCode: nodeGeo.countryCode,
        region: nodeGeo.regionName || nodeGeo.region,
        city: nodeGeo.city,
        latitude: nodeGeo.lat,
        longitude: nodeGeo.lon,
        timezone: nodeGeo.timezone,
        isp: nodeGeo.isp,
        asn: nodeGeo.as,
        asnOrg: nodeGeo.org,
        hosting: nodeGeo.hosting,
      };
    }

    // Apply technical fingerprint if available
    let technicalInfo = {};
    const fingerprint = fingerprintResults.get(gateway.fqdn);
    if (fingerprint) {
      technicalInfo = {
        responseTime: fingerprint.responseTime,
        serverHeader: fingerprint.serverHeader,
        httpVersion: fingerprint.httpVersion,
        supportedCompression: fingerprint.acceptsCompression,
        certIssuer: fingerprint.certInfo?.issuer,
        certIssueDate: fingerprint.certInfo?.issued,
        certExpiryDate: fingerprint.certInfo?.expires,
      };
    }

    // Initialize suspicion notes
    const suspicionNotes: string[] = [];

    // Check for minimum stake
    if (gateway.stake <= this.config.minStake) {
      suspicionNotes.push('minimum_stake');
    }

    return {
      fqdn: gateway.fqdn,
      wallet: gateway.wallet,
      stake: gateway.stake,
      status: gateway.status,
      registrationTimestamp: gateway.startTimestamp,

      ...domainInfo,
      baseDomain: domainInfo.baseDomain || gateway.fqdn,
      domainPattern: domainInfo.domainPattern || 'unknown',
      domainGroupSize: domainInfo.domainGroupSize || 0,
      ipAddress: dnsResult.ip,
      ipRange: dnsResult.ipRange,
      ...geoInfo,
      ...technicalInfo,

      // Scores will be calculated later
      domainCentralization: 0,
      networkCentralization: 0,
      stakeCentralization: 0,
      temporalCentralization: 0,
      technicalCentralization: 0,
      geographicCentralization: 0,
      overallCentralization: 0,

      clusterId: '',
      clusterSize: 0,
      clusterRole: 'primary' as const,
      suspicionNotes
    };
  }
  
  private analyzeDomain(fqdn: string): Partial<GatewayAnalysis> {
    const parts = fqdn.split('.');
    let baseDomain: string;
    
    // Handle multi-level TLDs and pseudo-TLDs
    const multiLevelTLDs = ['co.uk', 'co.jp', 'co.nz', 'com.au', 'com.br', 'net.au', 'org.uk', 'io.vn'];
    const lastTwo = parts.slice(-2).join('.');

    if (multiLevelTLDs.includes(lastTwo) && parts.length > 2) {
      baseDomain = parts.slice(-3).join('.');
    } else {
      baseDomain = parts.slice(-2).join('.');
    }
    
    const pattern = this.detectDomainPattern(fqdn);
    
    return {
      baseDomain,
      domainPattern: pattern,
      domainGroupSize: 0
    };
  }
  
  private detectDomainPattern(fqdn: string): string {
    const subdomain = fqdn.split('.')[0];
    
    // Sequential number patterns
    if (/^[a-z]+\d+$/.test(subdomain)) return 'prefix_number';
    if (/^\d+$/.test(subdomain)) return 'number_only';
    if (/^[a-z]+-\d+$/.test(subdomain)) return 'prefix-dash-number';
    if (/^[a-z]+_\d+$/.test(subdomain)) return 'prefix_underscore_number';
    
    // Common gateway patterns
    if (/^gw\d+/.test(subdomain)) return 'gw_pattern';
    if (/^gateway\d+/.test(subdomain)) return 'gateway_pattern';
    if (/^node\d+/.test(subdomain)) return 'node_pattern';
    if (/^ar\d+/.test(subdomain)) return 'ar_pattern';
    if (/^server\d+/.test(subdomain)) return 'server_pattern';
    if (/^host\d+/.test(subdomain)) return 'host_pattern';
    
    // Letter-based patterns (a.domain.com, b.domain.com)
    if (/^[a-z]$/.test(subdomain)) return 'single_letter';
    if (/^[a-z]{2}$/.test(subdomain)) return 'double_letter';
    
    // Region/location patterns
    if (/^(us|eu|asia|na|sa|af|oc)-\d+/.test(subdomain)) return 'region_number';
    if (/^(east|west|north|south|central)-\d+/.test(subdomain)) return 'direction_number';
    
    return 'unique';
  }
  
  private async getTechnicalFingerprint(fqdn: string): Promise<TechnicalFingerprint | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const options = {
        hostname: fqdn,
        port: 443,
        path: '/ar-io/info',
        method: 'GET',
        timeout: 5000,
        headers: {
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': 'AR-IO-Centralization-Analyzer/1.0'
        }
      };
      
      const req = https.request(options, (res) => {
        const responseTime = Date.now() - startTime;
        const headers = new Map(Object.entries(res.headers).map(([k, v]) => [k, String(v)]));
        
        const fingerprint: TechnicalFingerprint = {
          responseTime,
          httpVersion: res.httpVersion,
          responseHeaders: headers,
          serverHeader: res.headers['server'] as string | undefined,
          poweredBy: res.headers['x-powered-by'] as string | undefined,
          acceptsCompression: [],
        };
        
        // Check compression support
        const contentEncoding = res.headers['content-encoding'];
        if (contentEncoding && typeof contentEncoding === 'string') {
          fingerprint.acceptsCompression = contentEncoding.split(',').map(s => s.trim());
        }
        
        res.on('data', () => {}); // Consume response
        res.on('end', () => resolve(fingerprint));
      });
      
      req.on('secureConnect', () => {
        const socket = req.socket as tls.TLSSocket;
        const cert = socket.getPeerCertificate();
        
        if (cert && cert.issuer) {
          const reqWithFingerprint = req as typeof req & { fingerprint?: TechnicalFingerprint };
          const fingerprint = reqWithFingerprint.fingerprint || ({} as TechnicalFingerprint);
          fingerprint.certInfo = {
            issuer: cert.issuer.O || 'Unknown',
            issued: new Date(cert.valid_from),
            expires: new Date(cert.valid_to),
            subject: cert.subject?.CN || 'Unknown',
          };
          fingerprint.tlsVersion = socket.getProtocol() || undefined;
          fingerprint.tlsCiphers = [socket.getCipher()?.name].filter(Boolean) as string[];
          reqWithFingerprint.fingerprint = fingerprint;
        }
      });
      
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      
      req.end();
    });
  }
  
  private detectClusters() {
    // Only cluster gateways that resolved successfully
    const resolvedResults = this.results.filter(r => r.ipAddress !== 'resolution_failed');
    const domainGroups = this.groupBy(resolvedResults, r => r.baseDomain);
    let clusterId = 1;

    // Domain-based clusters - but only if they share infrastructure too
    domainGroups.forEach((gateways, domain) => {
      if (gateways.length >= 2) {
        // Check if gateways on this domain also share infrastructure
        // (IP ranges or ISP+Country) indicating centralized control
        const ipRanges = new Set(gateways.map(gw => gw.ipRange).filter(r => r !== 'unknown'));
        const isps = new Set(gateways.map(gw => gw.isp).filter(Boolean));
        const countries = new Set(gateways.map(gw => gw.country).filter(Boolean));

        // Calculate concentration on SINGLE most common IP range
        const ipRangeCounts = new Map<string, number>();
        gateways.forEach(gw => {
          if (gw.ipRange !== 'unknown') {
            ipRangeCounts.set(gw.ipRange, (ipRangeCounts.get(gw.ipRange) || 0) + 1);
          }
        });
        const maxIpRangeCount = Math.max(0, ...Array.from(ipRangeCounts.values()));
        const ipRangeConcentration = maxIpRangeCount / gateways.length;

        // Check if majority on same ISP+country combination
        const ispCountryCombos = new Map<string, number>();
        gateways.forEach(gw => {
          if (gw.isp && gw.country) {
            const key = `${gw.isp}|${gw.country}`;
            ispCountryCombos.set(key, (ispCountryCombos.get(key) || 0) + 1);
          }
        });
        const maxIspCountryCount = Math.max(0, ...Array.from(ispCountryCombos.values()));
        const ispCountryConcentration = maxIspCountryCount / gateways.length;

        // Stricter clustering criteria:
        // 1. 80%+ on the SAME single /24 IP range (clear centralization), OR
        // 2. 70%+ same ISP+country AND 50%+ IP concentration (probable centralization)
        const isInfrastructureClustered =
          ipRangeConcentration >= 0.8 ||
          (ispCountryConcentration >= 0.7 && ipRangeConcentration >= 0.5);

        if (!isInfrastructureClustered) {
          console.log(`  Skipping clustering for ${domain} (${gateways.length} gateways) - diverse infrastructure`);
          console.log(`    IP range concentration: ${(ipRangeConcentration * 100).toFixed(1)}% (max ${maxIpRangeCount} on single range)`);
          console.log(`    ISP+Country concentration: ${(ispCountryConcentration * 100).toFixed(1)}%`);
          console.log(`    Unique: ${ipRanges.size} IP ranges, ${isps.size} ISPs, ${countries.size} countries`);
          // Still set domainGroupSize for analysis, but don't create cluster
          gateways.forEach(gw => {
            gw.domainGroupSize = gateways.length;
          });
          return; // Skip clustering this domain
        }

        const id = `domain-${clusterId++}`;

        gateways.sort((a, b) => b.stake - a.stake);

        gateways.forEach((gw, idx) => {
          gw.clusterId = id;
          gw.clusterSize = gateways.length;
          gw.clusterRole = idx === 0 ? 'primary' : 'secondary';
          gw.domainGroupSize = gateways.length;

          if (!gw.suspicionNotes.includes('multiple_per_domain')) {
            gw.suspicionNotes.push('multiple_per_domain');
          }

          if (gw.domainPattern !== 'unique' && gateways.length >= 3) {
            if (!gw.suspicionNotes.includes('sequential_pattern')) {
              gw.suspicionNotes.push('sequential_pattern');
            }
          }
        });
      }
    });

    // Exact IP address clustering - multiple domains on same exact IP
    // This is a strong signal (much stronger than /24 range) that one operator
    // is running multiple gateways from the same server with different domain names
    const exactIpGroups = this.groupBy(
      this.results.filter(r => !r.clusterId && r.ipAddress !== 'resolution_failed'),
      r => r.ipAddress
    );

    exactIpGroups.forEach((gateways, exactIp) => {
      // Require 3+ gateways on exact same IP with different domains
      if (gateways.length >= 3) {
        // Check that they're actually different domains (not already caught by domain clustering)
        const uniqueDomains = new Set(gateways.map(gw => gw.baseDomain));
        if (uniqueDomains.size >= 2) {
          const id = `ip-exact-${clusterId++}`;
          gateways.forEach((gw, idx) => {
            gw.clusterId = id;
            gw.clusterSize = gateways.length;
            gw.clusterRole = idx === 0 ? 'primary' : 'secondary';

            if (!gw.suspicionNotes.includes('same_exact_ip')) {
              gw.suspicionNotes.push('same_exact_ip');
            }
          });

          console.log(`  Created exact IP cluster: ${gateways.length} gateways on ${exactIp}`);
          console.log(`    Domains: ${Array.from(uniqueDomains).join(', ')}`);
        }
      }
    });
  }
  
  private calculateTemporalScores() {
    const clusters = this.groupBy(
      this.results.filter(r => r.clusterId),
      r => r.clusterId
    );
    
    clusters.forEach((gateways) => {
      if (gateways.length < 2) return;
      
      const sorted = [...gateways].sort((a, b) => 
        (a.registrationTimestamp || 0) - (b.registrationTimestamp || 0)
      );
      
      const timeSpans: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const span = (sorted[i].registrationTimestamp || 0) - 
                    (sorted[i-1].registrationTimestamp || 0);
        timeSpans.push(span);
      }
      
      const maxSpan = Math.max(...timeSpans);
      const avgSpan = timeSpans.reduce((a, b) => a + b, 0) / timeSpans.length;
      
      gateways.forEach(gw => {
        if (maxSpan < 86400000) { // 24 hours
          gw.temporalCentralization = 0.9;
          if (!gw.suspicionNotes.includes('rapid_registration')) {
            gw.suspicionNotes.push('rapid_registration');
          }
        } else if (avgSpan < 604800000) { // 1 week average
          gw.temporalCentralization = 0.6;
          if (!gw.suspicionNotes.includes('close_registration_times')) {
            gw.suspicionNotes.push('close_registration_times');
          }
        } else {
          gw.temporalCentralization = 0.2;
        }
      });
    });
  }
  
  private calculateTechnicalScores() {
    const clusters = this.groupBy(
      this.results.filter(r => r.clusterId),
      r => r.clusterId
    );
    
    clusters.forEach((gateways) => {
      const fingerprints = gateways
        .map(gw => this.technicalFingerprints.get(gw.fqdn))
        .filter(Boolean) as TechnicalFingerprint[];
      
      if (fingerprints.length < 2) return;
      
      const serverHeaders = new Set(fingerprints.map(f => f.serverHeader));
      const httpVersions = new Set(fingerprints.map(f => f.httpVersion));
      const certIssuers = new Set(fingerprints.map(f => f.certInfo?.issuer));
      
      let technicalScore = 0;
      
      if (serverHeaders.size === 1 && serverHeaders.values().next().value) {
        technicalScore += 0.3;
      }
      
      if (httpVersions.size === 1) {
        technicalScore += 0.2;
      }
      
      if (certIssuers.size === 1) {
        technicalScore += 0.2;
      }
      
      const responseTimes = fingerprints.map(f => f.responseTime);
      const avgResponseTime = responseTimes.reduce((a, b) => a + b) / responseTimes.length;
      const similar = responseTimes.every(t => Math.abs(t - avgResponseTime) < 50);
      if (similar) {
        technicalScore += 0.3;
        gateways.forEach(gw => {
          if (!gw.suspicionNotes.includes('identical_performance')) {
            gw.suspicionNotes.push('identical_performance');
          }
        });
      }
      
      gateways.forEach(gw => {
        gw.technicalCentralization = Math.min(technicalScore, 1);
      });
    });
  }
  
  private calculateGeographicScores() {
    // Only score gateways that resolved successfully
    const resolvedResults = this.results.filter(r => r.ipAddress !== 'resolution_failed');

    // City-level clustering
    const cityGroups = this.groupBy(
      resolvedResults.filter(r => r.city),
      r => `${r.city}-${r.countryCode}`
    );
    
    cityGroups.forEach((gateways, _cityKey) => {
      if (gateways.length >= 5) {
        // 5+ gateways in same city is suspicious
        const score = Math.min(0.3 + (gateways.length - 5) * 0.1, 0.8);
        gateways.forEach(gw => {
          gw.geographicCentralization = Math.max(gw.geographicCentralization, score);
          if (!gw.suspicionNotes.includes('geographic_concentration')) {
            gw.suspicionNotes.push('geographic_concentration');
          }
        });
      }
    });
    
    // ISP/Hosting provider clustering
    const ispGroups = this.groupBy(
      resolvedResults.filter(r => r.isp),
      r => r.isp!
    );
    
    ispGroups.forEach((gateways, _isp) => {
      if (gateways.length >= 10) {
        // 10+ gateways with same ISP
        const score = Math.min(0.2 + (gateways.length - 10) * 0.05, 0.7);
        gateways.forEach(gw => {
          gw.geographicCentralization = Math.max(gw.geographicCentralization, score);
          if (!gw.suspicionNotes.includes('isp_concentration')) {
            gw.suspicionNotes.push('isp_concentration');
          }
        });
      }
      
      // Extra penalty for hosting providers
      if (gateways.length >= 5 && gateways[0].hosting) {
        gateways.forEach(gw => {
          gw.geographicCentralization = Math.max(gw.geographicCentralization, 0.5);
          if (!gw.suspicionNotes.includes('datacenter_hosting')) {
            gw.suspicionNotes.push('datacenter_hosting');
          }
        });
      }
    });
    
    // ASN clustering
    const asnGroups = this.groupBy(
      resolvedResults.filter(r => r.asn),
      r => r.asn!
    );
    
    asnGroups.forEach((gateways, _asn) => {
      if (gateways.length >= 15) {
        // 15+ gateways in same autonomous system
        const score = Math.min(0.3 + (gateways.length - 15) * 0.05, 0.8);
        gateways.forEach(gw => {
          gw.geographicCentralization = Math.max(gw.geographicCentralization, score);
          if (!gw.suspicionNotes.includes('asn_concentration')) {
            gw.suspicionNotes.push('asn_concentration');
          }
        });
      }
    });
    
    // Check clusters for geographic proximity
    const clusters = this.groupBy(
      this.results.filter(r => r.clusterId),
      r => r.clusterId
    );
    
    clusters.forEach((gateways) => {
      const geoGateways = gateways.filter(gw => gw.latitude && gw.longitude);
      if (geoGateways.length < 2) return;
      
      // Check if all gateways in cluster are geographically close
      let allClose = true;
      for (let i = 0; i < geoGateways.length - 1; i++) {
        for (let j = i + 1; j < geoGateways.length; j++) {
          const distance = this.getDistance(
            geoGateways[i].latitude!,
            geoGateways[i].longitude!,
            geoGateways[j].latitude!,
            geoGateways[j].longitude!
          );
          if (distance > 100) { // More than 100km apart
            allClose = false;
            break;
          }
        }
        if (!allClose) break;
      }
      
      if (allClose) {
        gateways.forEach(gw => {
          gw.geographicCentralization = Math.max(gw.geographicCentralization, 0.6);
          if (!gw.suspicionNotes.includes('geographic_proximity')) {
            gw.suspicionNotes.push('geographic_proximity');
          }
        });
      }
    });
  }
  
  private getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  private toRad(deg: number): number {
    return deg * (Math.PI/180);
  }
  
  private calculateFinalScores() {
    // Only calculate scores for resolved gateways
    const resolvedResults = this.results.filter(r => r.ipAddress !== 'resolution_failed');

    // Pre-compute IP range counts for O(1) lookup
    const ipRangeCounts = new Map<string, number>();
    for (const g of resolvedResults) {
      if (g.ipRange !== 'unknown') {
        ipRangeCounts.set(g.ipRange, (ipRangeCounts.get(g.ipRange) || 0) + 1);
      }
    }

    // Pre-compute cluster gateways for O(1) lookup
    const clusterGatewaysMap = new Map<string, typeof resolvedResults>();
    for (const g of resolvedResults) {
      if (g.clusterId) {
        if (!clusterGatewaysMap.has(g.clusterId)) {
          clusterGatewaysMap.set(g.clusterId, []);
        }
        clusterGatewaysMap.get(g.clusterId)!.push(g);
      }
    }

    resolvedResults.forEach(gateway => {
      // Domain centralization
      if (gateway.domainGroupSize > 1) {
        gateway.domainCentralization = Math.min(
          0.3 + (gateway.domainGroupSize - 1) * 0.2,
          1
        );

        if (gateway.domainPattern !== 'unique') {
          gateway.domainCentralization = Math.min(
            gateway.domainCentralization + 0.2,
            1
          );
        }
      }

      // Network centralization (using pre-computed map)
      const sameIpRange = ipRangeCounts.get(gateway.ipRange) || 0;

      if (sameIpRange > 2) {
        gateway.networkCentralization = Math.min(
          0.2 + (sameIpRange - 2) * 0.1,
          1
        );
      }

      // Stake centralization
      if (gateway.clusterId) {
        const clusterGateways = clusterGatewaysMap.get(gateway.clusterId) || [];
        const allMinStake = clusterGateways.every(g => g.stake <= this.config.minStake);
        if (allMinStake) {
          gateway.stakeCentralization = 0.5;
          if (!gateway.suspicionNotes.includes('all_minimum_stake')) {
            gateway.suspicionNotes.push('all_minimum_stake');
          }
        }

        // Check if most gateways in cluster have very similar stakes
        const stakes = clusterGateways.map(g => g.stake);
        const avgStake = stakes.reduce((a, b) => a + b) / stakes.length;
        const similarStakes = stakes.every(s => Math.abs(s - avgStake) / avgStake < 0.1);
        if (similarStakes && clusterGateways.length >= 3) {
          gateway.stakeCentralization = Math.max(gateway.stakeCentralization, 0.3);
          if (!gateway.suspicionNotes.includes('similar_stakes')) {
            gateway.suspicionNotes.push('similar_stakes');
          }
        }
      }

      // Overall score (weighted average)
      gateway.overallCentralization = Math.min(
        gateway.domainCentralization * 0.25 +
        gateway.networkCentralization * 0.15 +
        gateway.stakeCentralization * 0.10 +
        gateway.temporalCentralization * 0.15 +
        gateway.technicalCentralization * 0.10 +
        gateway.geographicCentralization * 0.25,
        1
      );
    });
  }
  
  private async generateReports() {
    // Sort by centralization score
    this.results.sort((a, b) => b.overallCentralization - a.overallCentralization);
    
    // Generate CSV
    const csvFilename = generateCSV(this.results);
    console.log(`\n✅ Detailed report saved to ${csvFilename}`);
    
    // Generate JSON summary
    const summary = this.generateSummary();
    const jsonFilename = generateJSON(summary);
    console.log(`📋 Summary saved to ${jsonFilename}`);
    
    // Generate HTML report
    const htmlContent = generateHTMLReport(summary, this.results, csvFilename, jsonFilename);
    const htmlFilename = `reports/gateway-centralization-report-${new Date().toISOString().split('T')[0]}.html`;
    const { writeFileSync, existsSync, mkdirSync } = await import('fs');
    
    // Ensure reports directory exists
    if (!existsSync('reports')) {
      mkdirSync('reports', { recursive: true });
    }
    
    writeFileSync(htmlFilename, htmlContent);
    console.log(`🌐 Interactive report saved to ${htmlFilename}`);
    
    // Print summary to console
    printSummary(summary, this.config.analyzePerformance);
  }
  
  private generateSummary(): CentralizationReport {
    // Only include resolved gateways in stats for unbiased analysis
    const resolvedGateways = this.results.filter(g => g.ipAddress !== 'resolution_failed');
    const failedDnsGateways = this.results.filter(g => g.ipAddress === 'resolution_failed');

    const clusters = this.groupBy(
      resolvedGateways.filter(g => g.clusterId),
      g => g.clusterId
    );

    const clusterSummaries: ClusterSummary[] = Array.from(clusters.entries()).map(([id, gateways]) => ({
      id,
      size: gateways.length,
      avgScore: gateways.reduce((sum, g) => sum + g.overallCentralization, 0) / gateways.length,
      baseDomain: gateways[0].baseDomain,
      pattern: gateways[0].domainPattern,
      gateways: gateways.map(g => g.fqdn),
      wallets: gateways.map(g => g.wallet)
    }));

    // Calculate economic impact if distribution data is available
    let economicImpact = undefined;
    if (this.distributionData && this.distributionData.rewards) {
      economicImpact = this.calculateEconomicImpact(clusterSummaries);
    }

    // Calculate infrastructure impact (only resolved gateways)
    const infrastructureImpact = this.calculateInfrastructureImpact(resolvedGateways);

    return {
      timestamp: new Date().toISOString(),
      totalGateways: resolvedGateways.length,
      totalGatewaysInNetwork: this.totalGatewaysInNetwork,
      totalResolved: resolvedGateways.length,
      totalFailedDns: failedDnsGateways.length,
      clusteredGateways: resolvedGateways.filter(g => g.clusterId).length,
      highCentralization: resolvedGateways.filter(g => g.overallCentralization > 0.7).length,
      clusters: clusterSummaries.sort((a, b) => b.avgScore - a.avgScore),
      topSuspicious: resolvedGateways
        .sort((a, b) => b.overallCentralization - a.overallCentralization)
        .slice(0, 100)
        .map(g => ({
          fqdn: g.fqdn,
          score: g.overallCentralization,
          reasons: g.suspicionNotes
        })),
      economicImpact,
      infrastructureImpact
    };
  }
  
  private calculateEconomicImpact(clusters: ClusterSummary[]): CentralizationReport['economicImpact'] {
    if (!this.distributionData) {
      console.log('No distribution data available');
      return undefined;
    }
    
    // totalEligibleGatewayReward is the reward PER gateway
    const rewardPerGateway = this.distributionData.totalEligibleGatewayReward || 0;
    
    if (rewardPerGateway === 0) {
      console.log('No gateway rewards data available');
      return undefined;
    }
    
    // Calculate total pool based on reward per gateway
    const totalGateways = this.results.length;
    const totalGatewayRewardPool = rewardPerGateway * totalGateways;
    
    console.log(`Economic impact estimation:`, {
      rewardPerGateway: rewardPerGateway / 1e6,
      totalGateways,
      totalGatewayRewardPool: totalGatewayRewardPool / 1e6
    });
    
    // Calculate estimated rewards per cluster
    const rewardsByCluster = clusters.map(cluster => {
      // Each gateway in cluster gets the per-gateway reward
      const clusterRewards = rewardPerGateway * cluster.size;
      
      cluster.totalRewards = clusterRewards;
      
      return {
        clusterId: cluster.id,
        clusterRewards,
        gatewayCount: cluster.size,
        percentageOfTotal: (clusterRewards / totalGatewayRewardPool) * 100
      };
    }).filter(c => c.clusterRewards > 0).sort((a, b) => b.clusterRewards - a.clusterRewards);
    
    // Calculate total estimated rewards going to centralized entities
    const topCentralizedRewards = rewardsByCluster.reduce((sum, c) => sum + c.clusterRewards, 0);
    const topCentralizedPercentage = (topCentralizedRewards / totalGatewayRewardPool) * 100;
    
    console.log(`Estimated centralized rewards: ${(topCentralizedRewards / 1e6).toFixed(2)} ARIO (${topCentralizedPercentage.toFixed(2)}%)`);
    
    return {
      totalDistributedRewards: totalGatewayRewardPool,
      rewardPerGateway,
      rewardsByCluster,
      topCentralizedRewards,
      topCentralizedPercentage
    };
  }

  private calculateInfrastructureImpact(gateways: GatewayAnalysis[]): InfrastructureImpact {
    // Count datacenter-hosted gateways
    const datacenterGateways = gateways.filter(g => g.hosting === true);
    const totalDatacenterHosted = datacenterGateways.length;
    const datacenterPercentage = gateways.length > 0
      ? (totalDatacenterHosted / gateways.length) * 100
      : 0;

    // Group by ISP/hosting provider
    const ispGroups = this.groupBy(
      gateways.filter(g => g.isp),
      g => g.isp!
    );

    // Calculate top providers
    const topProviders = Array.from(ispGroups.entries())
      .map(([name, gwList]) => ({
        name,
        count: gwList.length,
        percentage: gateways.length > 0 ? (gwList.length / gateways.length) * 100 : 0,
        gateways: gwList.map(g => g.fqdn)
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10 providers

    // Group by country
    const countryGroups = this.groupBy(
      gateways.filter(g => g.country),
      g => g.country!
    );

    // Calculate country distribution
    const countryDistribution = Array.from(countryGroups.entries())
      .map(([country, gwList]) => {
        const countryCode = gwList[0].countryCode || '';
        return {
          country,
          countryCode,
          count: gwList.length,
          percentage: gateways.length > 0 ? (gwList.length / gateways.length) * 100 : 0
        };
      })
      .sort((a, b) => b.count - a.count);

    const uniqueIsps = ispGroups.size;
    const uniqueCountries = countryGroups.size;
    const uniqueAsns = new Set(gateways.map(g => g.asn).filter(Boolean)).size;

    return {
      totalDatacenterHosted,
      datacenterPercentage,
      topProviders,
      countryDistribution,
      uniqueIsps,
      uniqueCountries,
      uniqueAsns
    };
  }

  private groupBy<T, K>(array: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const map = new Map<K, T[]>();
    array.forEach(item => {
      const key = keyFn(item);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(item);
    });
    return map;
  }
}