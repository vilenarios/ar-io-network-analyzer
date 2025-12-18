# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Network Centralization Analyzers for the Arweave ecosystem:

1. **AR.IO Gateway Analyzer** - Detects centralization patterns in AR.IO gateways using domain, geographic, network, and stake analysis
2. **Arweave Node Analyzer** - Analyzes the Arweave base layer node network via peer graph crawling and infrastructure analysis

## Key Commands

### AR.IO Gateway Analyzer

- `npm run analyze` - Run AR.IO gateway analyzer with real network data
- `npm run analyze:demo` - Run with demo data for testing
- `npm run analyze:performance` - Enable technical fingerprinting

### Arweave Node Analyzer

- `npm run analyze:arweave` - Crawl and analyze Arweave node network
- `npm run analyze:arweave:demo` - Run with demo data for testing

### Development

- `npm install` - Install dependencies
- `npm run build` - Build TypeScript to JavaScript
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier

### Environment Variables

**AR.IO Gateway Analyzer:**

- `ARIO_PROCESS_ID` - AR.IO process ID (default: qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE)
- `SKIP_GEO=true` - Skip geographic analysis to avoid API rate limits
- `USE_DEMO_DATA=true` - Use demo data instead of real network
- `ANALYZE_PERFORMANCE=true` - Enable performance fingerprinting
- `MIN_STAKE` - Minimum stake threshold (default: 10000)

**Arweave Node Analyzer:**

- `MAX_NODES` - Maximum nodes to crawl (default: 1000)
- `CONCURRENCY` - Parallel requests (default: 10)
- `TIMEOUT` - Request timeout in ms (default: 10000)
- `SKIP_GEO=true` - Skip geographic lookups
- `USE_DEMO_DATA=true` - Use demo data

## Architecture & Key Components

### Core Analysis Flow

1. **Gateway Fetching** (`src/data/gateway-fetcher.ts`)
   - Fetches gateway data from AR.IO network using `@ar.io/sdk`
   - Paginates through all gateways, filtering for `status: 'joined'`
   - Retrieves reward distribution data for economic analysis

2. **Multi-Factor Analysis** (`src/analyzer.ts`)
   - Domain analysis: Pattern detection, sequential numbering (ar1, ar2, etc.)
   - Geographic analysis: City/ISP/ASN clustering via ip-api.com
   - Network analysis: IP range (/24 subnet) and exact IP clustering
   - Temporal analysis: Registration timing patterns
   - Technical fingerprinting: Server configs, response times, TLS certs
   - Stake analysis: Minimum stake patterns

3. **Scoring System** (weighted in `calculateFinalScores`)
   - Domain: 25% - Multiple gateways on same domain
   - Geographic: 25% - Location/ISP/datacenter concentration
   - Network: 15% - Same IP ranges
   - Temporal: 15% - Close registration times
   - Stake: 10% - Minimum stake patterns
   - Technical: 10% - Similar server configurations

4. **Report Generation** (`src/utils/`)
   - Output to `reports/` directory
   - CSV: Detailed per-gateway analysis
   - JSON: Machine-readable summary with cluster data
   - HTML: Interactive dashboard with charts and filters

### Cluster Detection Logic

Domain-based clusters require infrastructure evidence (in `detectClusters`):

- 80%+ gateways on same /24 IP range, OR
- 70%+ same ISP+country AND 50%+ IP concentration

Exact IP clusters: 3+ gateways on identical IP with different domains.

### Suspicion Notes

Key flags added to `suspicionNotes` array:

- `minimum_stake`, `all_minimum_stake` - Stake-based patterns
- `multiple_per_domain`, `sequential_pattern` - Domain patterns
- `same_ip_range`, `same_exact_ip` - Network patterns
- `rapid_registration`, `close_registration_times` - Temporal patterns
- `geographic_concentration`, `isp_concentration`, `datacenter_hosting` - Geo patterns
- `identical_performance` - Technical fingerprint match

### Important Implementation Details

- **Rate Limiting**: Geographic lookups limited to 45/min (1.4s delay between requests)
- **Scoring Ranges**: 0.0-0.4 (low), 0.4-0.7 (medium), 0.7-1.0 (high) centralization
- **Economic Impact**: Calculates ARIO rewards going to centralized clusters based on per-gateway rewards

---

## Arweave Node Analyzer (`src/arweave/`)

### Architecture

1. **Node Discovery** (`node-crawler.ts`)
   - Fetches initial seeds from `arweave.net/peers`
   - BFS crawl via `/peers` endpoint on each node
   - Fetches `/info` for node metadata (version, height, peer count)
   - Rate-limited concurrent requests

2. **Peer Graph Analysis** (`peer-graph.ts`)
   - Adjacency list data structure
   - Metrics: degree, betweenness centrality, clustering coefficient
   - Community detection via label propagation algorithm
   - Bidirectional edge tracking

3. **Scoring System** (`arweave-analyzer.ts`)
   - Geographic: 30% - City/ISP/ASN concentration
   - Network: 30% - IP range clustering (/24, /16)
   - Infrastructure: 25% - Cloud provider dominance
   - Technical: 15% - Version uniformity, response times

4. **Report Generation** (`utils/arweave-html-generator.ts`)
   - Interactive Cytoscape.js peer graph visualization
   - Node coloring by risk/community/country/cluster
   - Charts for infrastructure and geographic distribution

### Key Data Structures

```typescript
interface ArweaveNodeAnalysis {
  ip: string;
  port: number;
  address: string; // "ip:port"

  // Node info
  version?: number;
  height?: number;
  peers?: number;
  isResponsive: boolean;

  // Graph metrics
  degree: number;
  inDegree: number;
  outDegree: number;
  betweennessCentrality?: number;
  communityId?: number;

  // Centralization scores (0-1)
  geographicCentralization: number;
  networkCentralization: number;
  infrastructureCentralization: number;
  overallCentralization: number;

  // Clustering
  clusterId: string;
  ipRange24: string; // /24 subnet
  suspicionNotes: string[];
}
```

### Suspicion Notes (Arweave)

- `same_ip_range_24` - Multiple nodes in /24 subnet
- `same_ip_range_16` - High concentration in /16 subnet
- `geographic_concentration` - Many nodes in same city
- `isp_concentration` - Many nodes with same ISP
- `datacenter_hosting` - Hosted in known datacenter
- `provider_dominance` - Major cloud provider concentration
- `community_concentration` - Tight peer graph community

---

## Dependencies

- `@ar.io/sdk` - AR.IO network SDK for gateway data
- TypeScript 5.3+ with ES2022 target
- Node.js 18+ required
