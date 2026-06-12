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
- `npm run analyze:fast` - Skip technical fingerprinting (faster)

### Arweave Node Analyzer

- `npm run analyze:arweave` - Crawl and analyze Arweave node network
- `npm run analyze:arweave:demo` - Run with demo data for testing

### Development

- `npm install` - Install dependencies
- `npm run build` - Build TypeScript to JavaScript
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier
- `npm run clean` - Remove dist/ and generated CSV/JSON files
- `tsx regenerate-html.ts [DATE]` - Regenerate HTML report from existing CSV/JSON data

### Environment Variables

**AR.IO Gateway Analyzer:**

- `ARIO_PROCESS_ID` - AR.IO process ID (default: qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE)
- `SKIP_GEO=true` - Skip geographic analysis to avoid API rate limits
- `USE_DEMO_DATA=true` - Use demo data instead of real network
- `ANALYZE_PERFORMANCE=true` - Enable performance fingerprinting
- `MIN_STAKE` - Minimum stake threshold (default: 10000)
- `DNS_CONCURRENCY` - Parallel DNS resolution requests (default: 50)
- `FINGERPRINT_CONCURRENCY` - Parallel fingerprinting requests (default: 20)
- `SKIP_MIGRATION_CHECK=true` - Skip Solana migration lookup via Goldsky

**Arweave Node Analyzer:**

- `MAX_NODES` - Maximum nodes to crawl (default: 5000)
- `CONCURRENCY` - Parallel requests (default: 30)
- `TIMEOUT` - Request timeout in ms (default: 3000)
- `DELAY` - Delay between requests in ms (default: 20)
- `RETRIES` - Retry failed requests (default: 1)
- `SKIP_GEO=true` - Skip geographic lookups
- `USE_DEMO_DATA=true` - Use demo data
- `SEED_NODES` - Comma-separated seed addresses (default: fetched from arweave.net)
- `OUTPUT_DIR` - Output directory for reports (default: `reports`)

## Technical Setup

- **ESM project**: `"type": "module"` in package.json — use `import`/`export`, not `require`
- **Runtime**: Scripts run via `tsx` (TypeScript execution without compilation). `npm run build` compiles to `dist/` but is not needed for development
- **No test framework**: No unit tests exist; validation is done by running analyzers with `USE_DEMO_DATA=true`
- **Reports are gitignored**: Output goes to `reports/` directory which is in `.gitignore`
- **Code style**: Prettier (single quotes, 100 char width, trailing commas es5, 2-space indent) and ESLint (`@typescript-eslint/no-explicit-any` is warn-only, unused vars error with `_` prefix exception)

## Architecture & Key Components

### AR.IO Gateway Analyzer

**Entry point**: `src/index.ts` → orchestrates fetch, analyze, report pipeline

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

4. **Solana Migration Check** (`src/data/migration-checker.ts`)
   - Queries Goldsky GraphQL (`arweave-search.goldsky.com`) for `AR-IO-Solana-Registration` attestations per gateway wallet
   - Batches `owners` lookups (50/req); persists permanent migrations to `reports/migration-cache.json`
   - Informational only — does not feed into the centralization score
   - Produces `MigrationStats` (migrated count/percentage, stake-weighted migration %, unmigrated gateway list)

5. **AR.IO Version Detection**
   - Technical fingerprint fetches gateway root with `Accept-Encoding: identity` so the response body can be parsed for `arIoVersion`/`arIoRelease`
   - Aggregated into `VersionStats` (top version, distribution, % reporting) — informational only

6. **Report Generation** (`src/utils/`)
   - CSV: Detailed per-gateway analysis (`report-generator.ts`)
   - JSON: Machine-readable summary with cluster data (`report-generator.ts`)
   - HTML: Interactive dashboard with charts, Globe.gl visualization, and filters (`html-generator.ts`)
   - Console: Summary output (`display.ts`)

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

- **Rate Limiting**: Geographic lookups (ip-api.com free tier) limited to 45/min (1.4s delay between requests)
- **Scoring Ranges**: 0.0-0.4 (low), 0.4-0.7 (medium), 0.7-1.0 (high) centralization
- **Economic Impact**: Calculates ARIO rewards going to centralized clusters based on per-gateway rewards

---

## Arweave Node Analyzer (`src/arweave/`)

**Entry point**: `src/arweave/arweave-index.ts`

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

### Suspicion Notes (Arweave)

- `same_ip_range_24` - Multiple nodes in /24 subnet
- `same_ip_range_16` - High concentration in /16 subnet
- `geographic_concentration` - Many nodes in same city
- `isp_concentration` - Many nodes with same ISP
- `datacenter_hosting` - Hosted in known datacenter
- `provider_dominance` - Major cloud provider concentration
- `community_concentration` - Tight peer graph community

### Types

- AR.IO types: `src/types.ts` (`GatewayAnalysis`, `CentralizationReport`)
- Arweave types: `src/arweave/arweave-types.ts` (`ArweaveNodeAnalysis`, `ArweaveNetworkReport`)

---

## Dependencies

- `@ar.io/sdk` - AR.IO network SDK for gateway data
- TypeScript 5.3+ with ES2022 target
- Node.js 18+ required
