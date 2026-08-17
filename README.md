# AR.IO Network Centralization Analyzer

TypeScript tools for detecting and analyzing centralization patterns in the Arweave ecosystem:

1. **AR.IO Gateway Analyzer** — Identifies clusters of AR.IO gateways that may be controlled by the same operators using domain, geographic, network, temporal, stake, and technical fingerprint analysis.
2. **Arweave Node Analyzer** — Crawls the Arweave base layer peer network and analyzes infrastructure distribution, peer graph topology, and geographic concentration.
3. **Observer Independence Indexer** — Continuously captures on-chain `Observation` accounts and detects observers that are not independent of one another. See below, plus [docs/observer-independence.md](docs/observer-independence.md) and [docs/operations.md](docs/operations.md).

## Installation

```bash
git clone https://github.com/vilenarios/ar-io-network-analyzer.git
cd ar-io-network-analyzer
npm install
```

## Requirements

- Node.js 20.9+ (see `.nvmrc` — `better-sqlite3` ships ABI-specific prebuilds; the observer indexer refuses to start on an older runtime)
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

### Observer Independence Indexer

Each epoch, AR.IO observers write an on-chain `Observation` account reporting on
gateway performance. If several nominally independent observers are in fact one
actor, the network's observation layer is centralized no matter how many gateway
addresses are registered. This indexer captures those accounts and looks for
exactly that.

```bash
yarn db:migrate            # create/migrate data/observations.sqlite
yarn capture:once          # one capture cycle (1 RPC call), then exit
yarn capture               # the daemon — run this continuously
yarn capture:status        # read-only health summary
yarn observers:findings    # recompute + publish findings (no network access)
yarn serve                 # read-only HTTP server for public/
```

#### What it looks for

Most detectors ask whether observers are too **alike** — sharing a report
transaction, producing near-identical bitmaps, sitting on the same
infrastructure. `divergent_assessment` asks the opposite question: whether they
are too **different**.

Each observer's bitmap has one bit per gateway, so its density summarises that
observer's verdict on the whole registry. Observers assessing the same
gateways over the same 24 hours should spread continuously around some
network-wide truth. A clean gap between two tight groups does not describe a
network — it describes two different measuring instruments.

Mainnet epochs 512–515 showed exactly that: one population at ~54% and another
at ~74%, with nobody in between, and the low group draining into the high one
(10 → 5 → 4 observers) as the high group filled (6 → 14 → 17). Observers that
held station on both sides rule out a simple degradation story; this is a
version or configuration change propagating through the observer set.

Both readings matter for centralization. Observers that agree because they run
identical software are not independent witnesses, and observers that disagree
by twenty points cannot all be right.

#### Why capture must run continuously

`close_observation` on the AR.IO program is **permissionless**: observation
accounts are swept off the chain within days of an epoch closing, and there is
no archive to backfill from. An hour of downtime is an hour of samples lost
permanently, for everyone. This is not a batch job that can be caught up later
— run it under a supervisor and alert on it (see
[docs/operations.md](docs/operations.md)).

The RPC budget is small enough that continuous operation is cheap: **~170 calls
and ~2–3 MiB per day**, since one `getProgramAccounts` returns every live
observation in the network.

#### What it detects

Twelve detectors over three families of evidence: identity (the same report
transaction, byte-identical result blobs), behaviour (near-identical results by
masked Hamming distance, co-submission timing), and infrastructure (shared IP,
/24, base domain, ASN, or analyzer cluster — joined from the daily analysis, so
the findings process never resolves DNS itself). Two more roll those up into
composite and persistent-correlation findings.

The result blob is treated as **opaque bytes** throughout: it is compared and
republished verbatim, never decoded into per-gateway verdicts.

`near_identical_results` is **uncalibrated** — its 0.90 threshold is a
placeholder, its findings are capped at `medium` severity and 0.5 confidence,
and they are marked `calibrated: false`. Run `yarn observers:calibrate` once
you have at least 14 captured epochs; it refuses to promote a threshold it has
measured as having no discriminating power. See
[docs/observer-independence.md](docs/observer-independence.md#4-why-near_identical_results-is-uncalibrated-and-what-it-costs).

#### npm scripts

| Script | What it does |
|---|---|
| `yarn capture` | Capture daemon. Polls every 10 minutes, single-instance, survives errors. |
| `yarn capture:once` | One cycle then exit. Use in cron only if you cannot run a daemon. |
| `yarn capture:status` | Last run, status, counts, consecutive unhealthy runs. |
| `yarn observers:findings` | Recompute findings for the rolling window and publish. |
| `yarn observers:backfill` | Same, over every captured epoch. |
| `yarn observers:calibrate` | Measure the similarity distribution; `--activate <id>` promotes a row. |
| `yarn serve` | Read-only HTTP server over `public/`. |
| `yarn db:migrate` / `yarn db:stats` | Apply migrations / print table counts. |
| `yarn test` | Unit tests (`node:test`). No network access. |

### Environment Variables

**Observer Independence Indexer:**

| Variable | Description | Default |
|---|---|---|
| `SOLANA_RPC_URL` | Endpoint for every on-chain read. May carry a provider token, so it is never logged, stored, or published — only its host is ever printed. | SDK `MAINNET_RPC_URL` |
| `OBSERVER_DB_PATH` | SQLite store. Irreplaceable — see backups. | `data/observations.sqlite` |
| `OBSERVER_POLL_INTERVAL_MS` | Capture interval | `600000` (10 min) |
| `POLL_RUN_RETENTION_DAYS` | How long the `poll_runs` log is kept. Observations are never pruned. | `30` |
| `OBSERVER_SIMILARITY_THRESHOLD` | Masked-Hamming threshold. **Uncalibrated placeholder** — measure, do not guess. | `0.90` |
| `OBSERVER_WINDOW_EPOCHS` | Rolling window the detectors consider | `30` |
| `OBSERVER_CO_SUBMISSION_WINDOW_S` | Co-submission clustering window | `60` |
| `PUBLIC_DIR` | Directory the publisher writes and the server serves | `public` |
| `PORT` / `HOST` | Server bind address | `8787` / `127.0.0.1` |
| `CAPTURE_MAX_AGE_SECONDS` | Age beyond which capture counts as stale | `3600` |
| `ANALYSIS_MAX_AGE_SECONDS` | Age beyond which the analysis/roster counts as stale | `172800` |

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
├── capture/                    # ENTRY (a): the capture daemon
│   ├── daemon.ts               # poll loop, single-instance, never dies on a cycle
│   ├── rpc.ts                  # the only network surface — 2 read-only methods
│   ├── decode.ts               # account decoding + layout canaries
│   ├── registry.ts             # registry slot-order snapshots
│   ├── status.ts               # how a cycle is judged (ok/stale/anomaly/failed)
│   └── lock.ts                 # single-instance guard
├── db/                         # SQLite store (migrations, read/write repos)
├── observers/                  # ENTRY (b): findings, calibration, rollups
│   ├── hamming.ts              # masked Hamming distance — the one new primitive
│   ├── detectors/              # the 12 detectors, in fixed order
│   ├── rollup.ts               # the single per-observer aggregation
│   └── roster.ts               # the single gateways.json -> GatewayFacts mapping
├── publish/                    # atomic tmp+rename publishing of public/
├── server/                     # ENTRY (c): read-only static server
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
yarn test          # Unit tests (node:test via tsx) — no network access
yarn lint          # Run ESLint
yarn format        # Format code with Prettier
yarn build         # Compile TypeScript to dist/
yarn clean         # Remove dist/ and generated CSV/JSON files
```

Tests live in `test/` and run against in-memory SQLite and synthetic fixtures.
They never contact an RPC endpoint; the capture path is exercised through an
injected decoder.

To regenerate an HTML report from existing CSV/JSON data:

```bash
npx tsx regenerate-html.ts 2025-11-13
```

## License

MIT License — See LICENSE file for details.

## Acknowledgments

Built for the AR.IO network community to promote transparency and decentralization.
