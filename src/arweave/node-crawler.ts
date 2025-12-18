/**
 * Arweave node crawler - BFS discovery via /peers endpoint
 */

import * as http from 'http';
import type {
  ArweaveNode,
  ArweaveNodeInfo,
  PeerEdge,
  CrawlerConfig,
  CrawlResult,
  CrawlStats,
} from './arweave-types.js';

const DEFAULT_PORT = 1984;

export class NodeCrawler {
  private config: CrawlerConfig;
  private visited: Set<string> = new Set();
  private queue: string[] = [];
  private nodes: Map<string, ArweaveNode> = new Map();
  private edges: PeerEdge[] = [];
  private startTime: number = 0;
  private responsiveCount: number = 0;
  private failedCount: number = 0;

  constructor(config: CrawlerConfig) {
    this.config = config;
  }

  async crawl(): Promise<CrawlResult> {
    this.startTime = Date.now();
    console.log(`Starting crawl with ${this.config.seedNodes.length} seed nodes...`);
    console.log(`Max nodes: ${this.config.maxNodes}, Concurrency: ${this.config.concurrency}`);

    // Initialize queue with seed nodes
    for (const seed of this.config.seedNodes) {
      const normalized = this.normalizeAddress(seed);
      if (normalized && !this.visited.has(normalized)) {
        this.queue.push(normalized);
      }
    }

    // Worker pool pattern - always keep `concurrency` requests in flight
    let activeWorkers = 0;
    let lastProgressUpdate = 0;

    const startWorker = async (): Promise<void> => {
      while (this.nodes.size < this.config.maxNodes) {
        // Get next unvisited address from queue
        let address: string | undefined;
        while (this.queue.length > 0) {
          const candidate = this.queue.shift()!;
          if (!this.visited.has(candidate)) {
            this.visited.add(candidate);
            address = candidate;
            break;
          }
        }

        if (!address) break; // Queue exhausted

        await this.processNode(address);

        // Rate limiting delay per request
        if (this.config.delayBetweenRequests > 0) {
          await this.delay(this.config.delayBetweenRequests);
        }
      }
    };

    // Progress update interval
    const progressInterval = setInterval(() => {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      process.stdout.write(
        `\r[${elapsed}s] Discovered: ${this.nodes.size}/${this.config.maxNodes} | ` +
          `Queue: ${this.queue.length} | Responsive: ${this.responsiveCount} | Failed: ${this.failedCount}   `
      );
    }, 500);

    // Start concurrent workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.config.concurrency; i++) {
      workers.push(startWorker());
    }

    await Promise.all(workers);
    clearInterval(progressInterval);

    // Final progress update
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r[${elapsed}s] Discovered: ${this.nodes.size}/${this.config.maxNodes} | ` +
        `Queue: ${this.queue.length} | Responsive: ${this.responsiveCount} | Failed: ${this.failedCount}   `
    );

    console.log('\n\nCrawl complete!');

    return {
      nodes: this.nodes,
      edges: this.edges,
      stats: this.calculateStats(),
    };
  }

  private async processNode(address: string): Promise<void> {
    const [ip, portStr] = address.split(':');
    const port = parseInt(portStr) || DEFAULT_PORT;

    // Validate port range
    if (port < 1 || port > 65535) {
      return;
    }

    const node: ArweaveNode = {
      ip,
      port,
      address,
      discoveredAt: Date.now(),
      isResponsive: false,
      inboundPeers: [],
      outboundPeers: [],
    };

    // Try to fetch node info with retries
    let info: ArweaveNodeInfo | null = null;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      info = await this.fetchNodeInfo(ip, port);
      if (info) break;
      if (attempt < this.config.retries) {
        await this.delay(500 * (attempt + 1)); // Exponential backoff
      }
    }

    if (info) {
      node.isResponsive = true;
      node.version = info.version;
      node.release = info.release;
      node.height = info.height;
      node.network = info.network;
      node.blocks = info.blocks;
      node.peers = info.peers;
      node.queueLength = info.queue_length;
      node.nodeStateLatency = info.node_state_latency;
      node.lastSeen = Date.now();
      this.responsiveCount++;

      // Fetch peers
      const peers = await this.fetchPeers(ip, port);
      if (peers.length > 0) {
        node.outboundPeers = peers;

        // Add edges and queue new peers
        for (const peerAddr of peers) {
          const normalizedPeer = this.normalizeAddress(peerAddr);
          if (!normalizedPeer) continue;

          // Create edge
          this.edges.push({
            source: address,
            target: normalizedPeer,
            discoveredAt: Date.now(),
            bidirectional: false, // Will be updated later
          });

          // Update inbound peers for target
          const existingPeer = this.nodes.get(normalizedPeer);
          if (existingPeer) {
            existingPeer.inboundPeers.push(address);
          }

          // Queue if not visited, under node limit, and queue not too large
          const MAX_QUEUE_SIZE = this.config.maxNodes * 3;
          if (!this.visited.has(normalizedPeer) &&
              this.nodes.size < this.config.maxNodes &&
              this.queue.length < MAX_QUEUE_SIZE) {
            this.queue.push(normalizedPeer);
          }
        }
      }
    } else {
      this.failedCount++;
    }

    this.nodes.set(address, node);
  }

  private async fetchNodeInfo(ip: string, port: number): Promise<ArweaveNodeInfo | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const req = http.get(
        {
          hostname: ip,
          port,
          path: '/info',
          timeout: this.config.timeout,
          headers: {
            'User-Agent': 'Arweave-Network-Analyzer/1.0',
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              if (res.statusCode === 200 && data) {
                const info = JSON.parse(data) as ArweaveNodeInfo;
                // Store response time on the node later
                resolve(info);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  private async fetchPeers(ip: string, port: number): Promise<string[]> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: ip,
          port,
          path: '/peers',
          timeout: this.config.timeout,
          headers: {
            'User-Agent': 'Arweave-Network-Analyzer/1.0',
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              if (res.statusCode === 200 && data) {
                const peers = JSON.parse(data) as string[];
                resolve(Array.isArray(peers) ? peers : []);
              } else {
                resolve([]);
              }
            } catch {
              resolve([]);
            }
          });
        }
      );

      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });
    });
  }

  normalizeAddress(peer: string): string | null {
    if (!peer || typeof peer !== 'string') return null;

    // Remove any protocol prefix
    peer = peer.replace(/^https?:\/\//, '');

    // Handle IPv6
    if (peer.includes('[')) {
      // IPv6 format: [::1]:1984
      const match = peer.match(/^\[([^\]]+)\]:?(\d+)?$/);
      if (match) {
        const ip = match[1];
        const port = match[2] || DEFAULT_PORT.toString();
        return `[${ip}]:${port}`;
      }
      return null;
    }

    // IPv4 handling
    const parts = peer.split(':');
    if (parts.length === 1) {
      // IP only, add default port
      if (this.isValidIPv4(parts[0])) {
        return `${parts[0]}:${DEFAULT_PORT}`;
      }
    } else if (parts.length === 2) {
      // IP:port format
      if (this.isValidIPv4(parts[0]) && !isNaN(parseInt(parts[1]))) {
        return `${parts[0]}:${parts[1]}`;
      }
    }

    return null;
  }

  private isValidIPv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
      const num = parseInt(part);
      return !isNaN(num) && num >= 0 && num <= 255;
    });
  }

  private calculateStats(): CrawlStats {
    return {
      totalDiscovered: this.nodes.size,
      totalResponsive: this.responsiveCount,
      totalFailed: this.failedCount,
      totalEdges: this.edges.length,
      crawlDuration: Date.now() - this.startTime,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Demo data generator for testing
export function getDemoNodes(): CrawlResult {
  console.log('Using demo data (set USE_DEMO_DATA=false to crawl real network)');

  const nodes = new Map<string, ArweaveNode>();
  const edges: PeerEdge[] = [];
  const now = Date.now();

  // Create demo nodes simulating various patterns
  const demoData = [
    // Cluster 1: Same datacenter (Hetzner, Germany)
    { ip: '95.217.1.1', port: 1984, isp: 'Hetzner', country: 'DE', city: 'Helsinki' },
    { ip: '95.217.1.2', port: 1984, isp: 'Hetzner', country: 'DE', city: 'Helsinki' },
    { ip: '95.217.1.3', port: 1984, isp: 'Hetzner', country: 'DE', city: 'Helsinki' },
    { ip: '95.217.1.4', port: 1984, isp: 'Hetzner', country: 'DE', city: 'Helsinki' },
    { ip: '95.217.1.5', port: 1984, isp: 'Hetzner', country: 'DE', city: 'Helsinki' },

    // Cluster 2: AWS US-East
    { ip: '54.210.1.1', port: 1984, isp: 'Amazon AWS', country: 'US', city: 'Ashburn' },
    { ip: '54.210.1.2', port: 1984, isp: 'Amazon AWS', country: 'US', city: 'Ashburn' },
    { ip: '54.210.1.3', port: 1984, isp: 'Amazon AWS', country: 'US', city: 'Ashburn' },

    // Cluster 3: DigitalOcean
    { ip: '159.65.1.1', port: 1984, isp: 'DigitalOcean', country: 'US', city: 'San Francisco' },
    { ip: '159.65.1.2', port: 1984, isp: 'DigitalOcean', country: 'US', city: 'San Francisco' },

    // Distributed nodes (legitimate)
    { ip: '1.2.3.4', port: 1984, isp: 'Comcast', country: 'US', city: 'Denver' },
    { ip: '8.8.8.1', port: 1984, isp: 'Google', country: 'US', city: 'Mountain View' },
    { ip: '185.199.1.1', port: 1984, isp: 'Cloudflare', country: 'US', city: 'San Jose' },
    { ip: '103.21.1.1', port: 1984, isp: 'Alibaba', country: 'CN', city: 'Shanghai' },
    { ip: '45.33.1.1', port: 1984, isp: 'Linode', country: 'US', city: 'Fremont' },
    { ip: '139.162.1.1', port: 1984, isp: 'Linode', country: 'JP', city: 'Tokyo' },
    { ip: '178.62.1.1', port: 1984, isp: 'DigitalOcean', country: 'GB', city: 'London' },
    { ip: '46.101.1.1', port: 1984, isp: 'DigitalOcean', country: 'DE', city: 'Frankfurt' },
  ];

  // Create nodes
  for (const data of demoData) {
    const address = `${data.ip}:${data.port}`;
    nodes.set(address, {
      ip: data.ip,
      port: data.port,
      address,
      version: 2,
      release: 70,
      height: 1450000 + Math.floor(Math.random() * 100),
      network: 'arweave.N.1',
      blocks: 1450000,
      peers: 50 + Math.floor(Math.random() * 100),
      discoveredAt: now,
      isResponsive: true,
      lastSeen: now,
      inboundPeers: [],
      outboundPeers: [],
    });
  }

  // Create peer relationships (edges)
  const nodeAddresses = Array.from(nodes.keys());

  // Cluster 1 nodes peer heavily with each other
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (i !== j) {
        edges.push({
          source: nodeAddresses[i],
          target: nodeAddresses[j],
          discoveredAt: now,
          bidirectional: true,
        });
        nodes.get(nodeAddresses[i])!.outboundPeers.push(nodeAddresses[j]);
        nodes.get(nodeAddresses[j])!.inboundPeers.push(nodeAddresses[i]);
      }
    }
  }

  // Cluster 2 nodes peer with each other
  for (let i = 5; i < 8; i++) {
    for (let j = 5; j < 8; j++) {
      if (i !== j) {
        edges.push({
          source: nodeAddresses[i],
          target: nodeAddresses[j],
          discoveredAt: now,
          bidirectional: true,
        });
        nodes.get(nodeAddresses[i])!.outboundPeers.push(nodeAddresses[j]);
        nodes.get(nodeAddresses[j])!.inboundPeers.push(nodeAddresses[i]);
      }
    }
  }

  // Random peering for distributed nodes
  for (let i = 10; i < nodeAddresses.length; i++) {
    // Each distributed node peers with 3-5 random others
    const peerCount = 3 + Math.floor(Math.random() * 3);
    for (let p = 0; p < peerCount; p++) {
      const targetIdx = Math.floor(Math.random() * nodeAddresses.length);
      if (targetIdx !== i) {
        edges.push({
          source: nodeAddresses[i],
          target: nodeAddresses[targetIdx],
          discoveredAt: now,
          bidirectional: Math.random() > 0.3,
        });
        nodes.get(nodeAddresses[i])!.outboundPeers.push(nodeAddresses[targetIdx]);
        nodes.get(nodeAddresses[targetIdx])!.inboundPeers.push(nodeAddresses[i]);
      }
    }
  }

  return {
    nodes,
    edges,
    stats: {
      totalDiscovered: nodes.size,
      totalResponsive: nodes.size,
      totalFailed: 0,
      totalEdges: edges.length,
      crawlDuration: 1000,
    },
  };
}

// Default seed nodes - these will be supplemented by fetching from arweave.net/peers
export const DEFAULT_SEED_NODES = [
  '38.29.227.87:1984',
  '134.195.197.55:1984',
  '165.254.143.27:1984',
  '49.12.135.160:1984',
  '136.243.154.80:1984',
];

// Fetch initial seed nodes from arweave.net gateway
export async function fetchSeedNodesFromGateway(): Promise<string[]> {
  try {
    const response = await fetch('https://arweave.net/peers', {
      headers: { 'User-Agent': 'Arweave-Network-Analyzer/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log('Failed to fetch from gateway, using default seeds');
      return DEFAULT_SEED_NODES;
    }

    const peers = await response.json() as string[];
    // Take first 50 peers as seeds
    const seeds = Array.isArray(peers) ? peers.slice(0, 50) : [];
    console.log(`Fetched ${seeds.length} seed nodes from arweave.net`);
    return seeds;
  } catch (error) {
    console.log('Failed to fetch from gateway, using default seeds');
    return DEFAULT_SEED_NODES;
  }
}
