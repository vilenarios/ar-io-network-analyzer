# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AR.IO Network Gateway Centralization Analyzer - a TypeScript tool for detecting and analyzing potential centralization patterns in the AR.IO network. It identifies clusters of gateways that may be controlled by the same operators through multi-factor analysis.

## Key Commands

### Development

- `npm install` - Install dependencies
- `npm run analyze` - Run analyzer with real network data
- `npm run analyze:demo` - Run with demo data for testing
- `npm run analyze:performance` - Run with performance analysis enabled
- `npm run build` - Build TypeScript to JavaScript
- `npm run lint` - Run ESLint (currently has 9 errors, 5 warnings)
- `npm run format` - Format code with Prettier

### Environment Variables

- `IO_PROCESS_ID` - AR.IO process ID (default: qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE)
- `SKIP_GEO=true` - Skip geographic analysis to avoid API rate limits
- `USE_DEMO_DATA=true` - Use demo data instead of real network
- `ANALYZE_PERFORMANCE=true` - Enable performance fingerprinting
- `MIN_STAKE` - Minimum stake threshold (default: 10000)

## Architecture & Key Components

### Core Analysis Flow

1. **Gateway Fetching** (`src/data/gateway-fetcher.ts`)
   - Fetches gateway data from AR.IO network using SDK
   - Retrieves reward distribution data for economic analysis

2. **Multi-Factor Analysis** (`src/analyzer.ts`)
   - Domain analysis: Pattern detection, sequential numbering
   - Geographic analysis: City/ISP/ASN clustering via ip-api.com
   - Network analysis: IP range clustering
   - Temporal analysis: Registration timing patterns
   - Technical fingerprinting: Server configs, response times
   - Stake analysis: Minimum stake patterns

3. **Scoring System** (weighted in `calculateFinalScores`)
   - Domain: 25% - Multiple gateways on same domain
   - Geographic: 25% - Location/ISP/datacenter concentration
   - Network: 15% - Same IP ranges
   - Temporal: 15% - Close registration times
   - Stake: 10% - Minimum stake patterns
   - Technical: 10% - Similar server configurations

4. **Report Generation** (`src/utils/`)
   - CSV: Detailed per-gateway analysis
   - JSON: Machine-readable summary
   - HTML: Interactive dashboard with charts
   - Console: Summary output

### Key Data Structures

```typescript
interface GatewayAnalysis {
  // Basic info
  fqdn: string;
  wallet: string;
  stake: number;

  // Analysis results
  domainCentralization: number; // 0-1 score
  geographicCentralization: number;
  networkCentralization: number;
  temporalCentralization: number;
  technicalCentralization: number;
  stakeCentralization: number;
  overallCentralization: number; // Weighted average

  // Clustering
  clusterId: string;
  clusterSize: number;
  suspicionNotes: string[]; // Reasons for suspicion
}
```

### Important Implementation Details

- **Rate Limiting**: Geographic lookups limited to 45/min (1.4s delay)
- **Clustering**: Gateways grouped by domain, IP range, patterns
- **Scoring**: 0.0-0.4 (low), 0.4-0.7 (medium), 0.7-1.0 (high) centralization
- **Economic Impact**: Calculates ARIO rewards going to centralized clusters

## Dependencies

- `@ar.io/sdk` - AR.IO network SDK
- TypeScript 5.3+ with ES2022 target
- Node.js 18+ required
