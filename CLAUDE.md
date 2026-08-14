# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Network Centralization Analyzers for the Arweave ecosystem:

1. **AR.IO Gateway Analyzer** - Detects centralization patterns in AR.IO gateways using domain, geographic, network, and stake analysis
2. **Arweave Node Analyzer** - Analyzes the Arweave base layer node network via peer graph crawling and infrastructure analysis
3. **Observer Independence Indexer** - Continuously captures on-chain `Observation` accounts and detects observers that are not independent (`src/capture`, `src/observers`, `src/publish`, `src/server`, `src/db`)

## Key Commands

### AR.IO Gateway Analyzer

- `npm run analyze` - Run AR.IO gateway analyzer with real network data
- `npm run analyze:demo` - Run with demo data for testing
- `npm run analyze:fast` - Skip technical fingerprinting (faster)

### Arweave Node Analyzer

- `npm run analyze:arweave` - Crawl and analyze Arweave node network
- `npm run analyze:arweave:demo` - Run with demo data for testing

### Observer Independence Indexer

- `yarn capture` - Capture daemon (10-minute poll). **Must run continuously.**
- `yarn capture:once` / `yarn capture:status` - One cycle / read-only health summary
- `yarn observers:findings` - Recompute + publish findings (never touches the network)
- `yarn observers:backfill` - Same, over every captured epoch
- `yarn observers:calibrate [--activate <id> [--force]]` - Measure / promote the similarity threshold
- `yarn serve` - Read-only HTTP server over `public/`
- `yarn db:migrate` / `yarn db:stats` - Apply migrations / table counts

### Development

- `npm install` - Install dependencies
- `yarn test` - Unit tests (`node:test` via tsx, in `test/`). No network access.
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
- **Tests**: `node:test` via tsx (`yarn test`, files in `test/`). They use in-memory SQLite and synthetic fixtures and must NEVER contact an RPC endpoint — the capture path is exercised through `useSdkDecoder()`. The two legacy analyzers still have no tests; validate those with `USE_DEMO_DATA=true`.
- **Node 20.9+ required**: `better-sqlite3` prebuilds are ABI-specific. Every entry point calls `assertNodeVersion()` before touching the native module so an old runtime produces a readable message, not a loader error.
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

---

## Observer Independence Indexer (`src/capture`, `src/observers`, `src/publish`, `src/server`, `src/db`)

Three processes share one SQLite file and one published directory. Full contract
in `docs/observer-independence.md`; operations in `docs/operations.md`.

| Process | Entry point | Cadence | Network |
|---|---|---|---|
| Capture | `src/capture/daemon.ts` | 10 min | 1 `getProgramAccounts` per cycle; hourly canary; ~1 `getAccountInfo`/day |
| Findings | `src/observers/run-findings.ts` | 10 min | **none** |
| Analysis | `src/index.ts` (`yarn analyze`) | daily | SDK + DNS + geo |
| Server | `src/server/index.ts` | always | serves `public/` read-only |

### Load-bearing facts (do not re-derive these)

- **`close_observation` is permissionless.** Observation accounts are deleted
  from the chain within days. Anything not captured while live is gone
  permanently — there is no backfill, ever. Every design decision in
  `src/capture` follows from this: never let a cycle kill the process, never
  report a cycle that captured nothing as success, never hold a lock a dead
  process left behind.
- **`reportTxId` is NOT unique.** Epoch 511: 17 observations, 11 distinct
  reports, 7 observers sharing one. The primary key is
  `(epoch_index, observer)`. Anything keyed on the report id collapses seven
  rows into one.
- **`gatewayResults` is OPAQUE.** 375 bytes whose bit encoding has not been
  verified end-to-end. It is compared as bytes, published verbatim as base64
  with `gatewayResultsMeaningfulBytes`, and never decoded into per-gateway
  verdicts. Every v1 detector sets `requiresDecodedResults: false`. A detector
  that needs the bits also needs `registryCaptured: true` for that epoch.
- **Only the first `ceil(gatewayCount/8)` bytes mean anything** (81 of 375 at
  `gatewayCount = 643`), and the final partial byte must be masked to its low
  `gatewayCount % 8` bits. Skipping either makes unrelated observers look ~78%
  identical. See the rules at the top of `src/observers/hamming.ts`.
- **The upsert is MONOTONIC, not just idempotent.** A read with an older
  `submittedAt` or from an older RPC context slot is refused (`'stale'`), never
  archived — otherwise a lagging replica overwrites newer data and the newer
  bytes survive only in `observation_revisions`, which nothing reads.
- **A registry snapshot is only decodable if taken in-epoch.** `getAccountInfo`
  on the registry PDA always returns the CURRENT slot order; labelling it with a
  past epoch is an approximation. `registry_snapshots.in_epoch` distinguishes
  them, and only the live epoch can be upgraded.
- **The similarity threshold is UNCALIBRATED.** At 0.90, 15 of 17 epoch-511
  observers land in one component. Findings are capped at medium/0.5 and marked
  `calibrated: false` until a calibration row is active, and a `NO_SEPARATION`
  calibration cannot be activated without `--force`.
- **`SOLANA_RPC_URL` may carry a provider token.** It is read in exactly two
  places (`src/capture/rpc.ts`, `src/data/gateway-fetcher.ts`) and never logged,
  stored or published — only `safeHost()` output. Every error that reaches a
  log or the database goes through `scrubSecrets()`.

### Where things live (do not duplicate them)

- One roster mapping: `src/observers/roster.ts` (`gateways.json` → `GatewayFacts`).
- One per-observer aggregation and ranking: `src/observers/rollup.ts`.
- One DNS implementation: `src/utils/dns.ts` (used only by the daily analysis).
- One cycle classifier: `src/capture/status.ts`.
- `src/publish/` writes `public/` and nothing else — no queries, no rollups.

### Gotchas

- SQLite serialises writers per **file**, not per table. Four processes write
  this file; the "disjoint tables" argument does not apply. Every DB write on
  the capture cycle path is wrapped so `SQLITE_BUSY` cannot kill the daemon.
- `src/arweave/*` is a separate track. Do not touch it. It is lint-warn-only in
  `.eslintrc.json` for exactly that reason.
- The HTML report is now SERVED, not just written to `reports/` — so
  interpolations are escaped (`esc()`) and script payloads go through
  `jsonForScript()`. `isp`/`org`/`city` come from a plaintext-HTTP geo lookup
  and `fqdn` comes from on-chain settings; both are attacker-influenced.

### Gotchas found during first bring-up (2026-08-14)

Each of these cost real time. None are visible from reading the code alone.

- **Nothing loads `.env`.** There is no `dotenv` dependency; every entry point
  reads `process.env` directly. The npm scripts pass node's own
  `--env-file-if-exists=.env`, which is what makes a manual run pick up
  `SOLANA_RPC_URL`. Add that flag to any new entry point, or it will silently
  fall back to the SDK's public `MAINNET_RPC_URL` and get rate-limited under
  continuous polling. The systemd unit works either way because it uses
  `EnvironmentFile`.
- **`yarn build` does not typecheck `test/`.** `tsconfig.json` sets
  `rootDir: src` and `include: src/**`, and `tsx` strips types at runtime, so a
  test can reference a field that does not exist and still pass. That happened:
  an XSS test built its fixture with `org` when the field is `asnOrg`, so
  `asnOrg` was silently uncovered by the test that appeared to cover it. Run
  `yarn typecheck` (`tsconfig.test.json`) — that is what catches it.
- **`.gitignore` has a blanket `*.json`.** Any new checked-in JSON config needs
  an explicit `!` exception, or `git add` refuses it and the file is silently
  absent from the commit. `tsconfig.test.json` needed one.
- **The protocol caps observers per epoch at 50** (`EpochSettings.maxObservers`).
  That bounds every pairwise detector at 1225 pairs, so similarity compute is a
  non-issue — but it also bounds the *payload*, which is why the published pair
  list is capped (below).
- **Two published documents are deliberately incomplete, and say so.** Findings
  publish the 20 most-similar pairs with `pairsTotal`/`pairsTruncated`, and
  `findings.json` carries a rolling window (`FINDINGS_FEED_EPOCHS`, default 30)
  with a `window` object on the wire. Both were unbounded: the full matrix
  reached ~220 KiB per finding at the observer cap, in a document that
  accumulated every epoch (~235 MiB projected at three years). Do not "fix" them
  by removing the caps. Older findings stay addressable at
  `epochs/<index>.json`, and the full matrix is reproducible from the stored
  blobs.
- **`docs/openapi.yaml` is guarded by a parity test.** `test/openapi-parity.test.ts`
  asserts both directions — every documented path is served, every served path is
  documented. Add a route without documenting it and the suite fails. It parses
  path keys by regex because the repo has no YAML dependency.
- **Capture is supervised by systemd**, not pm2. `deploy/arns-observer-capture.service`
  carries the real paths. pm2 is installed on this host but under node 16, and
  `pm2 startup` needs sudo anyway, so it buys nothing. A user-level systemd unit
  is not viable either: `Linger=no`.
- **A missed capture cycle is permanent.** `close_observation` is permissionless,
  so the network reclaims accounts regardless of local retention settings. This
  is why `Restart=always` matters more here than in a typical service, and why
  the alert should fire on `capture.stale` **and** on `accountCount == 0` — a
  zero count means the discriminator stopped matching, which otherwise looks
  exactly like a quiet network.

## Dependencies

- `@ar.io/sdk` - AR.IO network SDK for gateway data
- `@solana/kit` - Solana RPC client
- `better-sqlite3` - the observation store (native module; ABI-specific prebuilds)
- TypeScript 5.3+ with ES2022 target
- Node.js 20.9+ required
