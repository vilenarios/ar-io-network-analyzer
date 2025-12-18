# AR.IO Gateway Centralization Analyzer

A sophisticated TypeScript tool for detecting and analyzing potential centralization patterns in the AR.IO gateway network. This analyzer helps identify clusters of gateways that may be controlled by the same operators, providing insights into network decentralization and economic impact.

## Features

- **Multi-factor Centralization Detection**:
  - Domain pattern analysis (sequential numbering, common prefixes)
  - Geographic clustering (city, ISP, ASN, data center detection)
  - Network infrastructure clustering (IP ranges, datacenters)
  - Temporal analysis (registration timing patterns)
  - Economic behavior (stake levels, delegation patterns)
  - Technical fingerprinting (server configurations, response patterns)

- **Weighted Scoring System**:
  - Domain Centralization: 25% weight
  - Geographic Distribution: 25% weight
  - Network Similarity: 15% weight
  - Temporal Patterns: 15% weight
  - Stake Patterns: 10% weight
  - Technical Similarity: 10% weight

- **Output Formats**:
  - Detailed CSV report with all gateway metrics
  - JSON summary with cluster analysis
  - Interactive HTML dashboard with visualizations
  - Console summary with actionable insights

- **Economic Impact Analysis**:
  - Estimates ARIO token rewards distribution
  - Calculates rewards going to centralized clusters
  - Shows percentage of total reward pool at risk

## Installation

1. Clone this repository:

```bash
git clone https://github.com/vilenarios/ar-io-network-analyzer.git
cd ar-io-network-analyzer
```

2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

## Usage

### Basic Usage

```bash
# Run with real network data
npm run analyze

# Run with demo data (for testing)
npm run analyze:demo
```

### Configuration Options

```bash
# Skip geographic analysis (faster, avoids rate limits)
SKIP_GEO=true npm run analyze

# Use specific AR.IO process ID
ARIO_PROCESS_ID=YOUR_PROCESS_ID npm run analyze

# Set custom minimum stake threshold
MIN_STAKE=100000 npm run analyze

# Enable performance analysis (slower but more detailed)
npm run analyze:performance
```

### API Rate Limits

The geographic analysis uses ip-api.com (free tier):

- 45 requests per minute limit
- Automatic rate limiting (1.4s delay between requests)
- Use `SKIP_GEO=true` for large gateway sets

## Requirements

- Node.js 18+
- TypeScript 5+
- Network access to AR.IO gateways
- (Optional) Internet access for geographic lookups

## Output Files

All analysis results are saved to the `reports/` directory:

### CSV Report (`gateway-centralization-YYYY-MM-DD.csv`)

Contains detailed analysis for each gateway:

- Basic information (FQDN, wallet, stake, status)
- Domain analysis (base domain, pattern, group size)
- Network analysis (IP address, IP range)
- Performance metrics (response time, server headers)
- Centralization scores (0.0 to 1.0 for each factor)
- Cluster assignments and suspicion notes

### JSON Summary (`gateway-centralization-summary-YYYY-MM-DD.json`)

Machine-readable summary including:

- Total gateway statistics
- Cluster information with average scores
- Top 100 suspicious gateways with reasons
- Economic impact analysis
- Timestamp and metadata

### HTML Report (`gateway-centralization-report-YYYY-MM-DD.html`)

Interactive visual report that includes:

- **Dashboard Overview**: Key metrics and statistics at a glance
- **Interactive Charts**:
  - Centralization distribution pie chart
  - Top domains by gateway count
- **Data Tables**:
  - Summary of top 100 suspicious gateways
  - Full detailed analysis with search and filter
  - Cluster analysis breakdown
  - Economic impact analysis
- **Features**:
  - Dark/light theme toggle
  - Search functionality across all data
  - Filter by risk levels (High/Medium/Low)
  - Export options for CSV and JSON
  - Responsive design for mobile viewing

## Scoring Methodology

### Domain Centralization (25%)

- Multiple gateways on same domain increase score
- Sequential patterns (ar1, ar2, ar3) add bonus penalty
- Score calculation: `0.3 + (count - 1) * 0.2` (capped at 1.0)

### Geographic Centralization (25%)

- 5+ gateways in same city: High score
- 10+ gateways with same ISP: Medium-high score
- 15+ gateways in same ASN: High score
- Data center hosting adds additional penalty

### Network Centralization (15%)

- Gateways in same IP range (/24 subnet) are flagged
- Score increases with number of gateways in same range

### Temporal Centralization (15%)

- Gateways registered within 24 hours: High score (0.9)
- Gateways registered within 1 week: Medium score (0.6)
- Otherwise: Low score (0.2)

### Stake Centralization (10%)

- Clusters where all gateways have minimum stake: 0.5 score
- Similar stake amounts across cluster: 0.3 score

### Technical Centralization (10%)

- Identical server headers, HTTP versions, TLS configs
- Similar response times (within 50ms)
- Same certificate issuers

## Interpreting Results

### Centralization Score Ranges

- **0.0 - 0.4**: Low centralization (likely legitimate)
- **0.4 - 0.7**: Medium centralization (worth investigating)
- **0.7 - 1.0**: High centralization (strong evidence of same actor)

### Suspicion Notes

- `minimum_stake`: Gateway has minimum stake amount
- `multiple_per_domain`: Multiple gateways on same domain
- `sequential_pattern`: Follows numbered pattern (ar1, ar2, etc.)
- `rapid_registration`: Registered close together in time
- `same_ip_range`: Multiple gateways in same IP subnet
- `identical_performance`: Very similar response times
- `all_minimum_stake`: All gateways in cluster have minimum stake
- `geographic_concentration`: Many gateways in same city
- `isp_concentration`: Many gateways with same ISP
- `asn_concentration`: Many gateways in same autonomous system
- `datacenter_hosting`: Hosted in data center (not residential)
- `geographic_proximity`: Cluster gateways are geographically close
- `same_pattern_same_network`: Same naming pattern in same network
- `close_registration_times`: Registered within a week of each other
- `similar_stakes`: Very similar stake amounts across cluster

## Architecture

```
src/
├── analyzer.ts         # Main analyzer class
├── index.ts           # CLI entry point
├── types.ts           # TypeScript interfaces
├── data/
│   └── gateway-fetcher.ts  # AR.IO SDK integration
├── utils/
│   ├── display.ts          # Console output formatting
│   ├── geo-location.ts     # Geographic lookups
│   ├── html-generator.ts   # HTML report generation
│   └── report-generator.ts # CSV/JSON exports
```

## Development

```bash
# Install dependencies
npm install

# Run analyzer directly with tsx
npm run analyze

# Run linter
npm run lint

# Format code
npm run format

# Build for production
npm run build
```

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

Built for the AR.IO network community to promote transparency and decentralization.
