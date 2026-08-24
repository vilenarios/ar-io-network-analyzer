# Portal snapshot API — operations

> **Consuming the API rather than operating it?** See
> [`consuming-the-api.md`](./consuming-the-api.md) for the analyst/agent guide,
> and [`openapi.yaml`](./openapi.yaml) for the machine-readable contract. This
> file is about running the service.

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
| `gateways.json` | every gateway, SDK shape verbatim | ~90 KB |
| `balances.json` | every non-zero ARIO balance | ~91 KB |
| `vaults.json` | every vault (core program `VAULT`) | ~42 KB |
| `delegates.json` | every delegation | ~45 KB |
| `withdrawals.json` | every gateway withdrawal (GAR `WITHDRAWAL`) | ~42 KB |
| `primaryNames.json` | every primary name | ~19 KB |
| `arnsRecords.json` | every ArNS record | ~163 KB |
| `summary.json` | token supply, demand factor, registry settings, counts | ~1 KB |

**~494 KB gzipped for the entire network state** (measured 2026-08-24), of
which `arnsRecords.json` is ~163 KB. A consumer that only needs the name *count* should read
`summary.json` and never fetch it.

`vaults.json` and `withdrawals.json` are different datasets, not two views of
one: `getVaults` reads `VAULT` accounts in the **core** program, while
`getWithdrawals` / `getGatewayVaults` read `WITHDRAWAL` accounts in the **GAR**
program. Publishing one does not cover the other.

`delegates.json` answers three separate on-chain queries. Filter by `address`
for one wallet's delegations, by `gatewayAddress` for one gateway's delegators.
Neither needs its own request.

`withdrawals.json` answers the per-gateway vault view — filter by
`gatewayAddress`. It does **not** answer `getWithdrawals(address)`: both public
SDK projections drop the withdrawal's `owner`, and the decoder that keeps it is
behind a private method. That lookup stays a direct memcmp-filtered read, which
is the cheap class this service does not exist to displace.

`primaryNames.json` is small but pulls its weight: `getPrimaryName(address)` is
an **unfiltered** whole-program scan that deserializes every primary-name
account and filters client-side, so each visitor resolving one name scans the
whole set.

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
| `getAllGatewayVaults` | 1 | 144 |
| `getPrimaryNames` | 1 | 144 |
| `getArNSRecords` (full) | 1 | 144 |
| `getTokenSupply` | 1 | 144 |
| `getGatewayRegistrySettings` + `getDemandFactor` | 2 | 288 |

**~1,440 calls/day, flat.** It does not move when the portal gets busier — that
is the entire point.

`getArNSRecords` is fetched in full rather than with `{ limit: 1 }` and costs
exactly the same either way: the SDK scans the whole program and deserializes
every account before `paginate()` truncates **in memory**, so a limit narrows
the reply, not the query. The count in `summary.json` and the records in
`arnsRecords.json` come from one call.

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

# The units write here with StandardOutput=append:, which does NOT create the
# directory. `logs/` is gitignored, so a fresh clone does not have it and the
# service fails to start with a bare status=238/EXEC-style error that does not
# name the log path.
mkdir -p logs

sudo mkdir -p /etc/ario-portal-api /var/lib/ario-portal-api/{prod,testnet}/public
sudo chown -R vilenarios:vilenarios /var/lib/ario-portal-api

# One env file per instance. They must differ in endpoint, PUBLIC_DIR and PORT.
sudo install -m 0600 deploy/portal-api.prod.env.example    /etc/ario-portal-api/prod.env
sudo install -m 0600 deploy/portal-api.testnet.env.example /etc/ario-portal-api/testnet.env
sudo editor /etc/ario-portal-api/prod.env      # set SOLANA_RPC_URL

# Prove one cycle works before putting it under a supervisor.
PUBLIC_DIR=/var/lib/ario-portal-api/prod/public \
  SOLANA_RPC_URL=… yarn portal:once

# PREFLIGHT: the units name an absolute node path, because systemd does not
# inherit a login PATH and nvm is not on the system one. Confirm it matches
# this host before enabling anything — a mismatch fails at exec time with no
# useful message.
which node && node --version
grep -n 'nvm/versions' deploy/ario-portal-publish@.service
# If they differ, update BOTH the Environment=PATH and ExecStart lines in both
# unit files (the existing arns-observer-capture.service has the same pattern).

# install -m 644, not cp: systemd refuses to trust a world-writable unit and
# warns on an executable one, and file modes off a shared checkout are not
# reliably 644.
sudo install -m 644 deploy/ario-portal-publish@.service /etc/systemd/system/
sudo install -m 644 deploy/ario-portal-serve@.service   /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/ario-portal-publish@.service
sudo systemctl daemon-reload
sudo systemctl enable --now ario-portal-publish@prod ario-portal-serve@prod
sudo systemctl enable --now ario-portal-publish@testnet ario-portal-serve@testnet

sudo install -m 644 deploy/nginx-portal-api.conf /etc/nginx/sites-available/portal-api
sudo ln -s /etc/nginx/sites-available/portal-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### If the host has no load balancer

`deploy/nginx-portal-api.conf` assumes `load balancer -> nginx -> disk`, with
TLS terminating at the balancer. On a host that is itself the public address —
which is the case for the AR.IO services box, where every sibling service
terminates TLS locally with nginx + Let's Encrypt — installing it unchanged
publishes the API **unencrypted on port 80**, which its own header comment
forbids. On such a host:

- Give each vhost `listen 443 ssl` with a Let's Encrypt certificate, and keep
  `listen 80` only for the ACME challenge and a 301 redirect.
- **Delete `set_real_ip_from` and `real_ip_header`, do not re-point them.**
  With no trusted proxy in front, `$remote_addr` is already the true client
  address; leaving `real_ip_header X-Forwarded-For` in place would let any
  client set the header itself and walk straight past `limit_req`. There is no
  subnet to fill in — the correct value is no directive at all.
- Use `proxy_set_header X-Forwarded-Proto $scheme` on `/healthz`, not
  `$http_x_forwarded_proto`: TLS ends here, so the client's header is
  untrusted input rather than a balancer's statement.
- Split the two vhosts into separate site files if their DNS lands at
  different times — nginx will not load a config whose `ssl_certificate` path
  does not exist yet, so one missing cert otherwise blocks both. Move the
  shared `limit_req_zone` to `conf.d/` so it is declared exactly once.

### Host portability of the units

`User=`, `Group=` and the two absolute node paths in the unit files are
whatever the host that first ran this happened to have (`vilenarios`, an nvm
install under `/home/vilenarios`). They are **not** portable, and the runbook's
`chown -R vilenarios:vilenarios` is not either. On a new host, create a
dedicated service account, put node somewhere every account can read (an nvm
tree under `/root` is mode 700 and unreadable to a service user), and override
the unit with a drop-in rather than editing the shipped file:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin ario-portal
systemctl edit ario-portal-publish@prod     # User=, Group=, PATH=, ExecStart=
```

Two values in the nginx config must be set for this host before it is correct:

- **`set_real_ip_from`** defaults to `10.0.0.0/8` as a placeholder. Set it to the
  Hetzner load balancer's actual subnet. Leaving it broad lets any client
  upstream of nginx claim an arbitrary address via `X-Forwarded-For`, which
  makes the rate limit trivially bypassable.
- **`server_name`** on both blocks — `network.services.ar.io` and
  `network.services.ar-io.dev`. Point both at the load balancer in DNS, and
  terminate TLS there; these blocks listen on plain HTTP and must not be
  exposed publicly.

### Verify before pointing the portal at it

```bash
curl -s https://network.services.ar.io/healthz | jq '.status, .portal'
curl -sI https://network.services.ar.io/api/v1/portal/gateways.json   # 200, ETag, Cache-Control
curl -s https://network.services.ar.io/api/v1/portal/index.json | jq '.network, .freshness'
```

`network` must match the environment, and `freshness.stale` must be `false`.
Then set `VITE_PORTAL_API_URL` in the portal for that environment.

### Two instances, one box

`%i` in the template units selects `/etc/ario-portal-api/%i.env`. Everything
that must differ lives there:

| Variable | prod | testnet |
|---|---|---|
| `SOLANA_RPC_URL` | mainnet endpoint | devnet endpoint |
| `PORTAL_NETWORK` **(required)** | `mainnet` | `devnet` |
| `PUBLIC_DIR` | `/var/lib/ario-portal-api/prod/public` | `…/testnet/public` |
| `PORT` | 8787 | 8788 |

**`PORTAL_NETWORK` is required, not a hint.** The publisher refuses to start
if it is unset *and* the endpoint host does not literally contain a cluster
name — an internal resolver, a vanity domain, or a provider with domain masking
enabled all hit this. The refusal is deliberate: this repo's inference falls
back to `unknown`, the network portal's falls back to **`mainnet`**, and the
portal rejects any document whose `network` disagrees with its own answer. So
publishing `unknown` means every snapshot is silently refused while the
publisher keeps succeeding, `/healthz` stays green and no alert fires. A hard
startup failure is the only version of this that anyone finds out about.

**Program ids are per-cluster and are not configured here.** The SDK's defaults
are mainnet's; every other cluster deploys its programs at addresses derived
from its own keypair files, and `ARIOConfig` documents `coreProgramId` /
`garProgramId` / `arnsProgramId` / `antProgramId` as **required** off mainnet.
`initSolanaArio()` selects them from `DEVNET_PROGRAM_IDS` whenever the network
is not mainnet, so `PORTAL_NETWORK` (or a host that encodes the cluster) is
what drives them. Setting `PORTAL_NETWORK=mainnet` on a devnet endpoint, or
leaving the network `unknown`, scans devnet for mainnet PDAs and fails on the
first call — see §8.

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

### Testing the path production actually uses

`test/portal-e2e.test.ts` spawns the **Node** server. In production nginx serves
everything under `/api/v1/` off disk and Node only sees `/healthz`, so those
assertions describe a supported fallback, not what users receive. The visible
difference is the ETag: Node sends the document's published sha256, nginx sends
its own `"<mtime>-<size>"`.

`test/portal-nginx.test.ts` covers the production path and is opt-in, because it
needs a live nginx with published documents:

```bash
PORTAL_NGINX_BASE=https://network.services.ar.io yarn test
```

Without the variable those tests **skip** rather than pass. Run it after any
change to `deploy/nginx-portal-api.conf` — it is what catches a header dropped
from the manifest's nested `location` block, which is otherwise invisible until
a browser rejects the one document every consumer polls.

Rerun it any time:

```bash
PUBLIC_DIR=/var/lib/ario-portal-api/prod/public yarn portal:loadtest
LOAD_TARGET=https://network.services.ar.io yarn portal:loadtest   # through nginx
```

**The second command cannot meet the zero-failures bar against the shipped
nginx config, and that is the rate limiter working, not a regression.** The
load test drives 100 concurrent clients from one address; `limit_req` allows
30r/s with `burst=60` per address, so nginx correctly 503s the remainder. On
this deployment the run reported ~77,000 failures, all of them `limiting
requests` in the error log.

To measure nginx's actual serving capacity, point the load test at a temporary
vhost with the same `root`/`gzip_static`/`sendfile` blocks and the `limit_req`
line removed, on a loopback port. Measured that way on the services box:

| Path | Cold | Warm (304s) | Failures |
|---|---|---|---|
| Node directly | 760 req/s | 5,727 req/s | 0 |
| nginx, limiter removed | 809 req/s | 5,989 req/s | 0 |

Note that nginx's margin over Node is small here — this is a 4 GB shared box
and both are far from the disk. The reference figures in the table above (950 /
10,441) came from a development machine; treat them as a shape, not a target.

To load-test through the real vhost instead, raise the limit for the duration
or drive it from enough distinct source addresses that no single one exceeds
30r/s.
A small Hetzner instance is comfortable here. At **~494 KB per full visitor
load** (all eight documents plus the manifest, gzipped — measured on mainnet
2026-08-24), 20 TB of monthly traffic is roughly **43 million** full loads. The
whole dataset is well under a megabyte and stays in page cache.

Very few consumers pull the full set. `arnsRecords.json` alone is ~163 KB of
that; a client that only needs the name *count* reads it from `summary.json`
and never fetches the document, which puts a realistic load at ~331 KB.

## 7. Alerting

Alert on `/healthz`:

- **`portal.stale == true`** — the snapshot has stopped updating. At the
  default cadence this means two cycles have been missed.
- **`portal.consecutiveFailures > 2`** — the publisher is running but failing.
  Usually the endpoint: expired token, IP allowlist drift, or rate limiting.
- **`portal.published == false`** on an instance that should be publishing —
  the publisher has never completed a cycle.

Do not alert on a single failed cycle. One failure is normal; the publisher
keeps the previous documents and retries. `consecutiveFailures` of 1 or 2 is
silent by design; 3 is the first alert.

`deploy/ario-portal-healthcheck` implements exactly these three rules, plus the
two failure modes that are not in `/healthz` at all because they stop it
answering: an unreachable port and an unparseable body. Install it with its
timer:

```bash
sudo install -m 755 deploy/ario-portal-healthcheck /usr/local/bin/
sudo install -m 644 deploy/ario-portal-healthcheck.service /etc/systemd/system/
sudo install -m 644 deploy/ario-portal-healthcheck.timer   /etc/systemd/system/
sudo systemctl enable --now ario-portal-healthcheck.timer
```

It checks only instances whose publisher unit is `enabled`, so a box running
prod alone does not alert about a testnet that was never deployed. It notifies
on **state change** rather than on every check — a five-minute timer against a
condition that persists for hours would otherwise emit a notification every
five minutes, which trains people to ignore it — and emits a matching recovery
notice. Alerts go to the journal (`journalctl -t ario-portal-alert`), and also
to Slack if `PORTAL_ALERT_SLACK_WEBHOOK` is set in `/etc/ario-portal-api/alerts.env`.

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

### `ArioConfig not found at <redacted-token> on coreProgram <redacted-token>`

The program ids are wrong for the cluster the endpoint serves — almost always a
non-mainnet endpoint running with mainnet program ids (see §5). Check that
`PORTAL_NETWORK` matches the endpoint, and that `initSolanaArio()` is passing
the `DEVNET_PROGRAM_IDS` overrides.

The `<redacted-token>` placeholders are `scrubSecrets()`, not corruption: its
`\b[A-Za-z0-9_-]{32,}\b` rule matches any 32+ character alphanumeric run, and
every base58 Solana address is 32–44 characters. So **every program id and PDA
in an error message is redacted**, which makes exactly the errors that name an
address the hardest ones to read. The addresses involved are public constants,
not secrets. Until that is narrowed, recover them with:

```bash
node -e "const s=require('@ar.io/sdk');console.log(s.DEVNET_PROGRAM_IDS,s.MAINNET_PROGRAM_IDS)"
```

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
All eight documents carry one `generatedAt` so a client can confirm the set is
internally consistent.

**One exposure this does not cover.** A crash *between* the first document and
the manifest leaves documents newer than the manifest describing them. Nothing
is torn — every file is complete — but the manifest's digests no longer match
the bytes on disk, and the Node fallback serves those digests as ETags. A
consumer can be handed a body under an ETag that does not describe it, and a
revalidation can answer 304 for content that changed. It resolves itself on the
next successful cycle (at most one interval), and **nginx is unaffected**: it
stamps its own validator from mtime+size and never reads the manifest. Since
nginx serves every document in production, this is a fallback-path exposure
only.

The alternative ordering is worse: manifest first would advertise digests for
bytes that are not on disk at all, turning a stale ETag into a 404.

## 9. Consumer contract

For anyone building against this, including the portal:

- **Start at `index.json`.** It lists every document with size, sha256 and
  generation time. Prefer discovering paths from it over hardcoding them.
- **Check `freshness.stale` before trusting the data.** A failed cycle leaves
  the documents in place and records the failure there. Ignoring it makes a
  snapshot from a minute ago indistinguishable from one that stopped updating
  hours ago.
- **Send `If-None-Match`, and treat the ETag as opaque — echo back exactly
  what you received.** The Node fallback sets the ETag to the document's
  published sha256, but nginx serves these files off disk and stamps its own
  `"<mtime>-<size>"` validator, so the two paths return *different* ETags for
  identical bytes. Revalidation is correct either way as long as you echo the
  value the response gave you. What does **not** work is taking the `sha256`
  out of `index.json` and sending that as `If-None-Match`: through nginx — the
  production path — it matches nothing and you get a 200 with the full body.
  Verified against this deployment:

  | Request | Node (fallback) | nginx (production) |
  |---|---|---|
  | `If-None-Match:` echoed from the response | 304 | 304 |
  | `If-None-Match:` set to the manifest `sha256` | 304 | **200, full download** |

  The `sha256` in the manifest is for **integrity**, not revalidation. Use it
  to verify bytes you fetched; do not use it as a cache validator.
- **Check `programIds` before decoding.** Every document and the manifest name
  the four Solana programs they were derived from (`core`, `gar`, `arns`,
  `ant`). `network` alone is not enough: program ids are per-cluster, the SDK
  requires explicit overrides off mainnet, and a redeploy moves them. A client
  that decodes accounts from the wrong program does not get an error — it gets
  plausible nonsense. Compare against the ids your client is configured with
  and refuse a mismatch, the same way you would refuse a wrong `network`.

  They are repeated on every document rather than only in the manifest because
  documents are fetched individually and are often cached or copied away from
  it.

- **Balances are in mARIO**, as on chain. Convert at the display boundary.
- **Fall back to direct RPC** when a document is missing, stale beyond your
  tolerance, or the service is unreachable. This service must never be a hard
  dependency — the portal ships an immutable permaweb build, and a hard
  dependency on a host that lapses would brick it.
