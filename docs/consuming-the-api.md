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

#### Putting it in USD

Value **each epoch at its own price, then sum**. Do not convert a cumulative
ARIO total at today's price — those are different questions, and here they give
answers 16% apart, because ARIO moved −65% across these 16 epochs.

```bash
# operating inflow in ARIO and USD, excluding the epoch-510 treasury deposit
curl -s https://network.services.ar.io/api/v1/economics.json \
  | jq -r '.series as $s
      | [ range(1; $s|length) as $i
          | { epoch: $s[$i].epochIndex,
              ario: (($s[$i].protocolBalance - $s[$i-1].protocolBalance
                      + ($s[$i].totalEligibleRewards // 0)) / 1e6),
              price: $s[$i].arioPriceUsd } ]
      | map(select(.price != null))
      | map(.usd = .ario * .price)
      | { epochs: length,
          ario: (map(.ario) | add),
          usd:  (map(.usd)  | add) }'
```

As of epoch 523 that is **62,502,179.70 ARIO / $68,286.41** gross — but
60,000,000 ARIO of it is a deliberate treasury deposit, not revenue (see
below). Net of it: **2,502,179.70 ARIO / $2,337.41** across 15 epochs.

**Four things that will burn you.**

`totalEligibleRewards` is added, not subtracted: those rewards left the balance
during the epoch, so adding them back recovers what came *in*.

There is deliberately no `revenue` field, and epoch 510 is the reason. It shows
+60,100,376.84 ARIO of "inflow", of which **exactly 60,000,000 ARIO was a
deliberate treasury deposit** — two transfers from one authority on
2026-08-11 (69,420 then 59,930,580). Nothing in this document distinguishes
that from demand, because on-chain it is the same kind of movement.

So: label your derived figure *net protocol inflow*, not revenue, until inflows
are attributable by source — and exclude or annotate epoch 510 in any series a
human will read as earnings. At ~$66k it is 97% of the window's gross USD.

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

### `rewards.json` — what a position has actually earned

Per-position earnings, so you can show "you have earned this much" rather than
only "you currently hold this much". Rewards compound straight into stake, so
on-chain state never records what was earned — the difference has to come from
somewhere, and this document is that somewhere.

```bash
# one wallet's earnings, per epoch and in total
curl -s https://network.services.ar.io/api/v1/rewards.json \
  | jq --arg me "$ADDRESS" '
      .epochs as $e
      | .positions[] | select(.address == $me)
      | { gateway: .gatewayAddress, basis: .basis,
          totalARIO: (.totalRewards / 1e6),
          stakeARIO: (.currentStake / 1e6),
          perEpoch: [ $e, (.rewards | map(if . == null then null else ./1e6 end)) ] | transpose }'
```

**`basis` is the field to read first.** `events` means exact: decoded from the
program's own `CompoundDelegationRewards` events, which name the delegate, the
gateway and the amount. `inferred` means derived from stake movement, used for
gateway operators because `DistributeEpoch` emits only an epoch summary and no
per-operator record. Do not present the two as equivalent.

**`rewards` is aligned index-for-index with the top-level `epochs`.** A `null`
means that epoch was scanned and this position earned nothing. An epoch *absent*
from `epochs` was never scanned — render it as a gap, never a zero. "Scanned and
empty" and "not looked at" are different facts.

#### Computing a yield, without lying

There is deliberately no APY field. Annualizing days of history is an
extrapolation, and which one is a presentation decision. The components are all
here, so do it explicitly:

```bash
# network-wide realized delegate yield
curl -s https://network.services.ar.io/api/v1/rewards.json \
  | jq '(.epochs | length) as $n
        | (.totals.delegateRewards / 1e6) as $r
        | ([.positions[] | select(.currentStake != null) | .currentStake] | add / 1e6) as $s
        | { epochs: $n, rewardsARIO: $r, stakeARIO: $s,
            dailyYieldPct: (($r/$n)/$s*100),
            simpleAprPct: (($r/$n)/$s*365*100) }'
```

As of epoch 523 that is **18,204.68 ARIO over 16 epochs on 8,319,422.71 ARIO of
stake — 0.0137% per day, ~5.0% simple APR, ~5.1% compounded.**

Three ways to get this wrong, all of which produce a confident number:

- **Dividing by `epochsRewarded` instead of elapsed epochs.** A position credited
  in 2 of 16 epochs then looks like it earns every epoch. Always divide by the
  epochs that actually passed.
- **Trusting `currentStake` for a historical yield.** It is today's stake. Anyone
  who withdrew shows a wildly inflated return — the per-position spread here runs
  from 0.22% to over 1000% for exactly this reason, while the aggregate is ~5%.
- **Calling it APY.** Sixteen days is not a year. Prefer "realized yield over N
  epochs" until the history justifies annualizing.

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
