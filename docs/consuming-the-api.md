# Consuming the API — for analysts and agents

Everything this repo produces is static JSON over HTTPS. No auth, no
pagination, no rate negotiation: fetch a document, read it, done.

**Mainnet:** `https://network.services.ar.io`
**Devnet:** `https://network.services.ar-io.dev` — **portal namespace only.**
Observation capture and the centralization analysis are mainnet exercises and
deliberately do not run on devnet, so `/api/v1/network.json` and friends 404
there. See §5.

Machine-readable contract, served by the API itself so you can bootstrap from
the host alone:

```bash
curl -s https://network.services.ar.io/api/v1/openapi.yaml
```

It is republished every cycle from the deployed tree, so it always describes
the running code. Source: [`openapi.yaml`](./openapi.yaml).

## 1. Two namespaces, different jobs and different clocks

| | `/api/v1/portal/*` | `/api/v1/*` |
|---|---|---|
| Purpose | Live network state the portal renders | Analysis: who runs what, and do observers agree |
| Refresh | **every 10 min** | `network`/`gateways` **daily**; `observers`/`findings`/`epochs` **hourly** |
| Content | SDK records verbatim | Derived scores, clusters, findings, captured history |
| Staleness means | The publisher stopped | The *analysis* stopped — the network is fine |

Mixing the clocks is the easiest mistake to make. A 20-hour-old
`network.json` is normal; a 20-hour-old `portal/gateways.json` is an incident.

## 2. Start at a manifest

Both namespaces have one, and each lists every document with `sha256`, `bytes`
and `generatedAt`. Prefer discovering paths from it over hardcoding them.

```bash
curl -s https://network.services.ar.io/api/v1/index.json | jq '.documents | keys'
curl -s https://network.services.ar.io/api/v1/portal/index.json | jq '.documents | keys'
```

`/api/v1/index.json` also carries an `epochs` array — that is how you enumerate
per-epoch documents, which are not otherwise discoverable (`/api/v1/epochs`
with no index is a 404 by design).

## 3. The analysis documents

### `network.json` — start here

One fetch answers "how concentrated is this network, and do the observers
agree": `totals`, `clusters`, `topSuspicious`, `infrastructure`, and a rollup
of the observer findings.

```bash
curl -s https://network.services.ar.io/api/v1/network.json | jq '{
  generatedAt,
  analysed: .totals.gatewaysAnalyzed, of: .totals.gatewaysInNetwork,
  clustered: .totals.clustered, high: .totals.highCentralization,
  datacenterPct: .infrastructure.datacenterPercentage,
  providers: [.infrastructure.topProviders[:5][] | {name, count}],
  findings: .observers.bySeverity
}'
```

**Two traps.** `gatewaysAnalyzed` is only gateways that are `joined` *and*
publish an FQDN — about half the network — so never present it as a total. And
if `infrastructure.uniqueAsns` is `0`, the run had its geo stage disabled: the
infrastructure block will be empty and `totals.highCentralization` will read
`0` because geography carries 25% of the score. **That is a degraded run, not a
decentralized network.** Check `uniqueAsns` before believing a low score.

`economics` carries estimated reward concentration — `rewardPerGateway`,
`topCentralizedRewards`, `topCentralizedPercentage` and a per-cluster
breakdown. It is an **estimate** (per-gateway reward × cluster size), not a
record of payments. `versions` is null if the run skipped performance probes.

### `gateways.json` — per-gateway detail

The rows behind those aggregates. Join on FQDN to attribute a cluster to
operators, or to correlate scores with stake and rewards. Same
`joined` + FQDN filter applies.

> Not to be confused with `/api/v1/portal/gateways.json`, which is the raw SDK
> gateway records refreshed every 10 minutes. Same name, different namespace,
> different job.

### `observers.json` and `findings.json`

Observer independence over the captured window. `findings.json` carries every
finding with `kind`, `severity`, `confidence` and the `observers` involved;
`observers.json` is the roster and per-epoch participation.

```bash
# what kinds of collusion signal are firing, and how hard
curl -s https://network.services.ar.io/api/v1/findings.json \
  | jq '.findings | group_by(.kind) | map({kind: .[0].kind, n: length,
        high: map(select(.severity=="high")) | length})'
```

Findings quality depends on `gateways.json` existing — without it the
infrastructure detectors run degraded and produce roughly a quarter of the
findings. If `byKind` has no `shared_ip` or `analyzer_cluster_overlap`
entries, the daily analysis has not run.

### `economics.json` — the protocol balance over time

One row per completed epoch, oldest first. This exists because
`protocolBalance` used to be recomputed every cycle and immediately discarded:
only one sample ever existed, so no delta could be taken and protocol revenue
was not derivable at any point in time. Nothing new is measured — the missing
capability was retention.

```bash
# net protocol inflow per epoch, in ARIO, with the USD price of that day
curl -s https://network.services.ar.io/api/v1/economics.json \
  | jq -r '.series as $s | range(1; $s|length) as $i
           | ($s[$i].protocolBalance - $s[$i-1].protocolBalance
              + ($s[$i].totalEligibleRewards // 0)) as $inflow
           | [$s[$i].epochIndex, ($inflow / 1e6), $s[$i].arioPriceUsd] | @tsv'
```

**Four things that will burn you.**

`totalEligibleRewards` is added, not subtracted: those rewards left the balance
during the epoch, so adding them back recovers what came *in*.

There is deliberately no `revenue` field. The balance moves for reasons that
are not ArNS revenue — epoch 510 gained 60.07T mARIO in one step, which is a
treasury movement, not demand. Label your derived figure *net protocol inflow*
until inflows are attributable by source.

**The first row has no predecessor**, so its delta is undefined. Render null,
never zero. And never assume `series[i+1].epochIndex == series[i].epochIndex+1`:
an epoch whose balance could not be read is omitted permanently rather than
interpolated, so gaps are real and must be drawn as gaps.

**Only `protocolBalance` is guaranteed non-null.** Rows recovered from chain
history carry `null` for `demandFactor`, `circulating`, `staked`, `delegated`
and `arnsRecordCount` — that state is not in transaction metadata and is not
worth inventing. `arioPriceUsd` is independently nullable and carries its own
provenance in `arioPriceSource`, which distinguishes a spot reading from a
daily close.

Every row is anchored to its epoch boundary (`endTimestamp`, with `slot`
pinning the exact read), so consecutive rows really are one epoch apart.

### `epochs/<n>.json` — the irreplaceable one

Per-epoch observation reports: `observer`, `reportTxId`, `submittedAt`,
`gatewayCount` and `gatewayResultsBase64` (encoding `gar-bitmap-v1-lsb`), plus
that epoch's findings.

**This is the only data here that cannot be re-derived.** Observation PDAs are
closed by the permissionless `close_observation` once an epoch distributes,
which refunds the observer's rent and deletes the account. After that the chain
keeps `observations_submitted` — the count — and loses the content. These
documents are the surviving copy.

```bash
# enumerate captured epochs, then pull one
curl -s https://network.services.ar.io/api/v1/index.json \
  | jq -r '.documents.epochs[].path' | sort
curl -s https://network.services.ar.io/api/v1/epochs/522.json \
  | jq '{epochIndex, observationCount, distinctReportTxIds,
         observers: [.observations[].observer]}'
```

Coverage is whatever capture was running for — check the manifest rather than
assuming a contiguous range.

## 4. Caching

Send `If-None-Match` and **echo back exactly the ETag you received**. Do not
send the `sha256` from the manifest: nginx serves these files off disk and
stamps its own `"<mtime>-<size>"` validator, so a manifest digest matches
nothing in production. The digest is for verifying bytes you already have, not
for revalidation.

```bash
etag=$(curl -sI …/network.json | awk -F'"' '/etag/{print $2}')
curl -sI -H "If-None-Match: \"$etag\"" …/network.json | head -1   # 304
```

Every document has a precompressed `.gz` sibling; just send
`Accept-Encoding: gzip`.

## 5. Devnet has no analysis, on purpose

`https://network.services.ar-io.dev` publishes the **portal namespace only**.
Capture and the centralization analysis are mainnet-only: running them against
a throwaway network would spend RPC and DNS on data nobody consumes, and make
"is the network centralized" ambiguous about which network is meant. The units
are plain, non-templated services bound to the mainnet environment file, so
this is structural rather than a convention.

## 6. Health and freshness

```bash
curl -s https://network.services.ar.io/healthz | jq
```

- `portal.*` — the 10-minute publisher. `stale: true` means it stopped.
- `capture.*` — observation capture. `status: "anomaly"` with
  `accountCount: 0` usually means the **network** submitted no observations,
  not that capture is broken; check `observations_submitted` on the epoch
  account before investigating the daemon.
- `analysis.*` — the daily run. `gatewayCount` is the analysed count.
- The **top-level** `published` refers to the capture/analysis pipeline, not
  the portal. Read `portal.published` for the portal.

`consecutiveFailures` on capture is counted over the last 50 poll runs, so it
saturates at 50 and stays there while a condition persists.
