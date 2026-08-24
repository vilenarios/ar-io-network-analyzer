# Portal snapshot API — operations

The network portal used to run `getProgramAccounts` over whole Solana programs
from **every visitor's browser**, so RPC cost scaled with how popular the site
was. This service runs those scans once per cadence and publishes static JSON.

Whole-program scans go from `visitors × N` to a flat `N × 144/day`.

## 1. The processes

| Process | Command | Cadence | Writes | Talks to the network |
|---|---|---|---|---|
| Publisher | `yarn portal` | 10 min | `$PUBLIC_DIR/api/v1/portal/` | 7 reads per cycle |
| Server | `yarn serve` | always | nothing | serves `$PUBLIC_DIR` read-only |
| nginx | — | always | nothing | serves the documents off disk |

In normal operation **nginx serves every document directly** and Node only
answers `/healthz`. The Node server remains a working fallback, but it reads
each file synchronously per request, so it is not what you want in front of
traffic.

## 2. Documents

All under `/api/v1/portal/`, each with a precompressed `.gz` sibling written at
publish time.

| Document | Content | Size (mainnet, gzipped) |
|---|---|---|
| `index.json` | manifest: digests, sizes, freshness | ~1 KB |
| `gateways.json` | every gateway, SDK shape verbatim | ~92 KB |
| `balances.json` | every non-zero ARIO balance | ~92 KB |
| `vaults.json` | every vault | ~44 KB |
| `delegates.json` | every delegation | ~48 KB |
| `summary.json` | token supply, demand factor, registry settings, counts | ~1 KB |

**~280 KB gzipped for the entire network state.**

`delegates.json` answers three separate on-chain queries. Filter by `address`
for one wallet's delegations, by `gatewayAddress` for one gateway's delegators.
Neither needs its own request.

Documents carry the SDK's decoded shape verbatim rather than a projection. A
projection would be smaller by a few tens of kilobytes and would break silently
every time the portal rendered a field it dropped.

## 3. RPC cost budget

Per cycle, at the default 10-minute interval:

| Call | Per cycle | Per day |
|---|---|---|
| `getGateways` | 1 | 144 |
| `getVaults` | 1 | 144 |
| `getBalances` | 1 | 144 |
| `getAllDelegates` | 1 | 144 |
| `getArNSRecords` (count only, `limit: 1`) | 1 | 144 |
| `getTokenSupply` | 1 | 144 |
| `getGatewayRegistrySettings` + `getDemandFactor` | 2 | 288 |

**~1,150 calls/day, flat.** It does not move when the portal gets busier — that
is the entire point.

Halving `PORTAL_POLL_INTERVAL_MS` doubles all of it.

## 4. The endpoint must not have a referrer allowlist

This is the one deployment fact that is not obvious and will cost an hour if
missed.

The publisher is a server process. It sends no browser `Referer`, and
`@solana/kit` **refuses to let you set one** — it enforces the browser
forbidden-header list even in Node:

```
SolanaError: HTTP header(s) forbidden: referer.
```

So an endpoint protected by a referrer allowlist returns 401 to this service no
matter which auth method is used. Verified against a live endpoint:

| Auth | Referer | Result |
|---|---|---|
| path token | none | 401 |
| `x-token` header | none | 401 |
| `x-token` header | present | 200 |

Provision a **separate endpoint with an IP allowlist**. That is better practice
anyway:

|  | Browser endpoint | Publisher endpoint |
|---|---|---|
| Visibility | public by necessity — inlined in the bundle, permanent on Arweave | a real secret, never shipped |
| Protection | referrer allowlist | IP allowlist |
| Rotation | breaks every user until a redeploy | free, no user impact |

## 5. Deploy

```bash
git clone … /programs/ar-io-network-analyzer && cd /programs/ar-io-network-analyzer
nvm use            # .nvmrc → 22; better-sqlite3 prebuilds are ABI-specific
yarn install

sudo mkdir -p /etc/ario-portal-api /var/lib/ario-portal-api/{prod,testnet}/public
sudo chown -R vilenarios:vilenarios /var/lib/ario-portal-api

# One env file per instance. They must differ in endpoint, PUBLIC_DIR and PORT.
sudo install -m 0600 deploy/portal-api.prod.env.example    /etc/ario-portal-api/prod.env
sudo install -m 0600 deploy/portal-api.testnet.env.example /etc/ario-portal-api/testnet.env
sudo editor /etc/ario-portal-api/prod.env      # set SOLANA_RPC_URL

# Prove one cycle works before putting it under a supervisor.
PUBLIC_DIR=/var/lib/ario-portal-api/prod/public \
  SOLANA_RPC_URL=… yarn portal:once

sudo cp deploy/ario-portal-*@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ario-portal-publish@prod ario-portal-serve@prod
sudo systemctl enable --now ario-portal-publish@testnet ario-portal-serve@testnet

sudo cp deploy/nginx-portal-api.conf /etc/nginx/sites-available/portal-api
sudo ln -s /etc/nginx/sites-available/portal-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Two instances, one box

`%i` in the template units selects `/etc/ario-portal-api/%i.env`. Everything
that must differ lives there:

| Variable | prod | testnet |
|---|---|---|
| `SOLANA_RPC_URL` | mainnet endpoint | devnet endpoint |
| `PORTAL_NETWORK` | `mainnet` | `devnet` |
| `PUBLIC_DIR` | `/var/lib/ario-portal-api/prod/public` | `…/testnet/public` |
| `PORT` | 8787 | 8788 |

Sharing a `PUBLIC_DIR` between instances would have each overwrite the other's
documents with a different network's data, which would look like data
corruption rather than a config error. They must differ.

The testnet instance runs **only** the portal publisher — no capture, no
findings, no analysis. `/healthz` reports the portal independently, so an
instance without a capture daemon is not reported as degraded for lacking one.

## 6. Capacity

Measured on a development machine with the real mainnet snapshot, 100
concurrent clients:

| Phase | Throughput | p50 | p99 | Failures |
|---|---|---|---|---|
| Cold (full document downloads) | 950 req/s | 10 ms | 91 ms | 0 |
| Warm (`If-None-Match` → 304) | 10,441 req/s | 9 ms | 22 ms | 0 |

That is the **Node** server, which reads each file synchronously per request.
nginx with `sendfile` and `gzip_static` is materially faster and is what serves
documents in production.

Rerun it any time:

```bash
PUBLIC_DIR=/var/lib/ario-portal-api/prod/public yarn portal:loadtest
LOAD_TARGET=https://network.services.ar.io yarn portal:loadtest   # through nginx
```

A small Hetzner instance is comfortable here. At ~280 KB per full visitor load,
20 TB of monthly traffic is roughly 75 million full loads; the whole dataset is
under a megabyte and stays in page cache.

## 7. Alerting

Alert on `/healthz`:

- **`portal.stale == true`** — the snapshot has stopped updating. At the
  default cadence this means two cycles have been missed.
- **`portal.consecutiveFailures > 2`** — the publisher is running but failing.
  Usually the endpoint: expired token, IP allowlist drift, or rate limiting.
- **`portal.published == false`** on an instance that should be publishing —
  the publisher has never completed a cycle.

Do not alert on a single failed cycle. One failure is normal; the publisher
keeps the previous documents and retries.

## 8. Recovery

### The snapshot is stale

```bash
systemctl status ario-portal-publish@prod
tail -50 logs/portal-prod.log
yarn portal:status            # freshness without touching the network
```

The log line names the failure. The common ones are all endpoint-side: `401`
(token rotated, or the endpoint gained a referrer allowlist), `403` (method
blocked), `429` (rate limited — raise the interval or the provider limit).

### The publisher refuses to publish

```
refusing to publish: the gateway scan returned zero accounts
```

This is deliberate. A zero-gateway result is not a quiet network — it is a
filter that stopped matching, a wrong program id, or an endpoint returning
empty results. Publishing it would replace good documents with an empty set,
and every consumer would render an empty network. The previous documents are
kept and the manifest is marked stale.

Check the program ids and the endpoint before doing anything else.

### Documents are gone

Nothing here is irreplaceable — unlike the observation capture in this repo,
every portal document is re-derivable from chain at any time. Run
`yarn portal:once` and the set is rebuilt.

### A cycle looks torn

It cannot be observed as torn: each document is written scratch → fsync →
rename, and the manifest is written last. A consumer reading the manifest and
then a document never sees a manifest describing bytes that are not on disk.
All six documents carry one `generatedAt` so a client can confirm the set is
internally consistent.

## 9. Consumer contract

For anyone building against this, including the portal:

- **Start at `index.json`.** It lists every document with size, sha256 and
  generation time. Prefer discovering paths from it over hardcoding them.
- **Check `freshness.stale` before trusting the data.** A failed cycle leaves
  the documents in place and records the failure there. Ignoring it makes a
  snapshot from a minute ago indistinguishable from one that stopped updating
  hours ago.
- **Send `If-None-Match`.** ETags are the published sha256 digests, so
  revalidation is cheap and correct.
- **Balances are in mARIO**, as on chain. Convert at the display boundary.
- **Fall back to direct RPC** when a document is missing, stale beyond your
  tolerance, or the service is unreachable. This service must never be a hard
  dependency — the portal ships an immutable permaweb build, and a hard
  dependency on a host that lapses would brick it.
