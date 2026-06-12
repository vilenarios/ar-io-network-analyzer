# AR.IO Network Centralization Analyzer

TypeScript tools for detecting and analyzing centralization patterns in the Arweave ecosystem:

1. **AR.IO Gateway Analyzer** — Identifies clusters of AR.IO gateways that may be controlled by the same operators using domain, geographic, network, temporal, stake, and technical fingerprint analysis.
2. **Arweave Node Analyzer** — Crawls the Arweave base layer peer network and analyzes infrastructure distribution, peer graph topology, and geographic concentration.

## Installation

```bash
git clone https://github.com/vilenarios/ar-io-network-analyzer.git
cd ar-io-network-analyzer
npm install
```

## Requirements

- Node.js 18+
- Network access to AR.IO gateways and/or Arweave nodes
- (Optional) Internet access for geographic lookups via ip-api.com

## Usage

### AR.IO Gateway Analyzer

```bash
# Run with real network data
npm run analyze

# Run with demo data (no network access needed)
npm run analyze:demo

# Skip technical fingerprinting (faster)
npm run analyze:fast
```

### Arweave Node Analyzer

```bash
# Crawl and analyze Arweave node network
npm run analyze:arweave

# Run with demo data (no network access needed)
npm run analyze:arweave:demo
```

### Environment Variables

**AR.IO Gateway Analyzer:**

| Variable | Description | Default |
|---|---|---|
| `ARIO_PROCESS_ID` | AR.IO process ID | `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE` |
| `USE_DEMO_DATA` | Use demo data instead of real network (`true`/`false`) | `false` |
| `SKIP_GEO` | Skip geographic analysis to avoid API rate limits (`true`/`false`) | `false` |
| `ANALYZE_PERFORMANCE` | Enable performance fingerprinting (`true`/`false`) | `true` |
| `MIN_STAKE` | Minimum stake threshold | `10000` |
| `DNS_CONCURRENCY` | Parallel DNS resolution requests | `50` |
| `FINGERPRINT_CONCURRENCY` | Parallel fingerprinting requests | `20` |
| `SKIP_MIGRATION_CHECK` | Skip Solana migration lookup via Goldsky (`true`/`false`) | `false` |

**Arweave Node Analyzer:**

| Variable | Description | Default |
|---|---|---|
| `USE_DEMO_DATA` | Use demo data instead of crawling (`true`/`false`) | `false` |
| `MAX_NODES` | Maximum nodes to crawl | `5000` |
| `CONCURRENCY` | Parallel requests | `30` |
| `TIMEOUT` | Request timeout in ms | `3000` |
| `DELAY` | Delay between requests in ms | `20` |
| `RETRIES` | Retry failed requests | `1` |
| `SKIP_GEO` | Skip geographic lookups (`true`/`false`) | `false` |
| `SEED_NODES` | Comma-separated list of seed node addresses | Fetched from `arweave.net` |
| `OUTPUT_DIR` | Output directory for reports | `reports` |

### API Rate Limits

The geographic analysis uses ip-api.com (free tier):

- 45 requests per minute limit
- Automatic rate limiting (1.4s delay between requests)
- Use `SKIP_GEO=true` for large sets or to avoid rate limits

## Output Files

All analysis results are saved to the `reports/` directory.

### AR.IO Gateway Reports

- **CSV** (`gateway-centralization-YYYY-MM-DD.csv`) — Per-gateway detail: FQDN, wallet, stake, domain/network/geographic analysis, centralization scores (0.0–1.0), cluster assignments, and suspicion notes.
- **JSON** (`gateway-centralization-summary-YYYY-MM-DD.json`) — Machine-readable summary with gateway statistics, cluster info, top suspicious gateways, and economic impact analysis.
- **HTML** (`gateway-centralization-report-YYYY-MM-DD.html`) — Interactive dashboard with Globe.gl visualization, centralization distribution charts, searchable/filterable data tables, cluster breakdown, and economic impact analysis.

### Arweave Node Reports

- **CSV** (`arweave-network-analysis-YYYY-MM-DD.csv`) — Per-node detail: IP, port, version, height, peer count, graph metrics, centralization scores, and cluster assignments.
- **JSON** (`arweave-network-summary-YYYY-MM-DD.json`) — Network-level summary with infrastructure distribution, geographic concentration, and graph statistics.
- **HTML** (`arweave-network-report-YYYY-MM-DD.html`) — Interactive report with Cytoscape.js peer graph visualization, infrastructure/geographic distribution charts, and node coloring by risk, community, country, or cluster.

## Scoring Methodology

### AR.IO Gateway Scoring

Weighted composite score (0.0–1.0):

| Factor | Weight | What it measures |
|---|---|---|
| Domain | 25% | Multiple gateways on same domain, sequential patterns (ar1, ar2, ar3) |
| Geographic | 25% | City/ISP/ASN clustering, datacenter hosting |
| Network | 15% | Same /24 IP subnet |
| Temporal | 15% | Registration timing proximity |
| Stake | 10% | Minimum stake patterns, similar amounts across cluster |
| Technical | 10% | Identical server headers, response times, TLS configs |

### Arweave Node Scoring

| Factor | Weight | What it measures |
|---|---|---|
| Geographic | 30% | City/ISP/ASN concentration |
| Network | 30% | IP range clustering (/24, /16) |
| Infrastructure | 25% | Cloud provider dominance |
| Technical | 15% | Version uniformity, response times |

### Score Interpretation

- **0.0–0.4**: Low centralization (likely legitimate)
- **0.4–0.7**: Medium centralization (worth investigating)
- **0.7–1.0**: High centralization (strong evidence of same actor)

## Architecture

```
src/
├── index.ts                    # AR.IO analyzer entry point
├── analyzer.ts                 # Multi-factor centralization analysis
├── types.ts                    # TypeScript interfaces
├── data/
│   └── gateway-fetcher.ts      # AR.IO SDK integration
├── utils/
│   ├── display.ts              # Console output formatting
│   ├── geo-location.ts         # Geographic lookups (ip-api.com)
│   ├── html-generator.ts       # HTML report with Globe.gl
│   └── report-generator.ts     # CSV/JSON exports
└── arweave/
    ├── arweave-index.ts        # Arweave analyzer entry point
    ├── arweave-analyzer.ts     # Infrastructure & centralization analysis
    ├── arweave-types.ts        # Arweave type definitions
    ├── node-crawler.ts         # BFS peer network crawler
    ├── peer-graph.ts           # Graph metrics & community detection
    └── utils/
        ├── arweave-display.ts  # Console output formatting
        └── arweave-html-generator.ts  # HTML report with Cytoscape.js
```

## Development

```bash
npm run lint       # Run ESLint
npm run format     # Format code with Prettier
npm run build      # Compile TypeScript to dist/
npm run clean      # Remove dist/ and generated CSV/JSON files
```

To regenerate an HTML report from existing CSV/JSON data:

```bash
npx tsx regenerate-html.ts 2025-11-13
```

## License

MIT License — See LICENSE file for details.

## Acknowledgments

Built for the AR.IO network community to promote transparency and decentralization.
