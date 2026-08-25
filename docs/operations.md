# Operations runbook — observation capture

> Consuming these documents rather than running the pipeline? See
> [`consuming-the-api.md`](./consuming-the-api.md).

The one thing this runbook exists to protect: **`close_observation` is
permissionless**. Observation accounts are swept off the chain within days of
an epoch closing, and there is no archive to backfill from. An hour of downtime
is an hour of samples lost; a week of downtime is a week of epochs that can
never be analysed by anyone, ever. Capture is not a batch job that can be
caught up later.

Everything else here follows from that.

---

## 1. The three processes

| Process | Command | Cadence | Writes | Talks to the network |
|---|---|---|---|---|
| Capture | `yarn capture` | every 10 min | `data/observations.sqlite` | **1** `getProgramAccounts`, plus an hourly canary and ~1 `getAccountInfo`/day |
| Findings | `yarn observers:findings` | every 10 min | findings tables, `public/` | never |
| Analysis | `yarn analyze` | daily | `reports/`, `public/`, `analysis_runs` | AR.IO SDK, DNS, ip-api geo |
| Server | `yarn serve` | always | nothing | serves `public/` read-only |

Only capture may be behind. The other three are recomputable from what capture
stored.

## 2. Deploy

```bash
git clone … && cd ar-io-network-analyzer
nvm use            # .nvmrc → 22; better-sqlite3 prebuilds are ABI-specific
yarn install
cp .env.example .env    # set SOLANA_RPC_URL if you have a dedicated endpoint
yarn db:migrate         # creates + migrates data/observations.sqlite
yarn capture:once       # one cycle, verifies RPC + decode + schema end to end
```

Then run capture under a supervisor. systemd unit:

```ini
[Unit]
Description=AR.IO observation capture
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ar-io-network-analyzer
EnvironmentFile=/opt/ar-io-network-analyzer/.env
ExecStart=/usr/bin/env yarn capture
Restart=always
RestartSec=15
# SIGTERM lets an in-flight cycle reach its COMMIT before exiting.
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

### The other two cadences are NOT optional, and are easy to forget

Capture is the only process that cannot be recomputed, so it gets all the
attention — but **scheduling only capture leaves the published documents
frozen**. The database keeps growing and none of it reaches a consumer. On the
first real deployment this went unnoticed until `/healthz` was read carefully:
`analysis.lastRunAt` was **11 days** stale (`gatewayCount: 18`) while capture
was running perfectly.

There is a second-order effect too. `observers:findings` degrades without a
published `gateways.json`, which only `analyze` produces — it logs
`infrastructure detectors run degraded`. Scheduling the analysis took this
deployment from **47 findings to 201** over the same 13 epochs, because the
infrastructure detectors could finally run.

`deploy/` ships timers for both:

```bash
sudo install -m 644 deploy/arns-observer-findings.{service,timer} /etc/systemd/system/
sudo install -m 644 deploy/arns-network-analyze.{service,timer}   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arns-observer-findings.timer arns-network-analyze.timer
systemctl list-timers 'arns-*'      # confirm both are scheduled
```

`reports/` is gitignored and absent from a fresh clone — the same trap as
`logs/`. `analyze` writes there with `writeFileSync` and dies at the first
report if it does not exist, so create it and make it writable by the service
account, and list it in `ReadWritePaths` if the unit uses `ProtectSystem=strict`.

On a small box, turn down the **concurrency** — not the stages. The defaults
(`DNS_CONCURRENCY=50`, `FINGERPRINT_CONCURRENCY=20`) issue hundreds of
concurrent lookups across ~650 gateways; `DNS_CONCURRENCY=10
FINGERPRINT_CONCURRENCY=5` keeps it to a trickle at no cost to the result.

**Do not reach for `SKIP_GEO=1` / `ANALYZE_PERFORMANCE=false` to make it
cheaper.** They are not a fidelity dial, they are an off switch for the
analysis this job exists to produce, and the report still generates and still
looks plausible without them — which is what makes it dangerous. Measured on
the same network, same day:

| | geo + performance off | full |
|---|---|---|
| runtime | 14s @ load 0.11 | 131s @ load 0.79 |
| `totals.highCentralization` | **0** | **230** |
| `infrastructure.totalDatacenterHosted` | 0 | 203 (64%) |
| unique ISPs / countries / ASNs | 0 / 0 / 0 | 27 / 10 / 23 |
| `topProviders`, `countryDistribution` | empty | populated |
| `versions` | `null` | populated |

Centralization scoring weights geography at 25%, so with the geo stage off the
scores collapse and every gateway looks uncontroversial. For a once-a-day job,
131s is nothing — and most of it is waiting on ip-api's rate limit rather than
burning CPU. The geo stage catches its own per-batch failures and degrades
rather than aborting, so an ip-api outage costs that section, not the run.

`economics` in `network.json` is populated (it was `null` until two compounding
bugs were fixed: a normaliser dropped `totalEligibleGatewayReward`, and the
guard tested a `.rewards` field the calculation never uses). It is an estimate —
per-gateway reward times cluster size — not a record of payments.

Not to be confused with `/api/v1/economics.json`, the retained protocol-balance
time series, which is a different document with a different job.

The equivalent in cron, if you prefer it:

```cron
*/10 * * * *  cd /programs/ar-io-network-analyzer && yarn observers:findings >> logs/findings.log 2>&1
17   4 * * *  cd /programs/ar-io-network-analyzer && yarn analyze          >> logs/analyze.log 2>&1
```

A single-instance guard (`poll_lock`) makes a second capture daemon refuse to
start. It takes over a lock whose heartbeat has stopped for three intervals,
and immediately takes over a lock left on **this host** by a pid that no longer
exists — so a crash or SIGKILL does not lock the supervisor out.

## 3. RPC cost budget

Per capture cycle at the default 10-minute interval:

| Call | Frequency | Payload |
|---|---|---|
| `getProgramAccounts` (dataSize + discriminator filtered) | 1 per cycle — 144/day | ~14 KiB for ~31 accounts (469 B each) |
| `getProgramAccounts` (discriminator only, `dataSlice` 0) — the layout canary | 1 per hour — 24/day | keys only |
| `getAccountInfo` on the registry PDA | once per newly seen epoch, plus once more if the live epoch's snapshot is still approximate — ~1–2/day | ~168 KiB |

**~170 calls/day, ~2–3 MiB/day.** Comfortably inside a free public endpoint;
the reason to configure a dedicated `SOLANA_RPC_URL` is reliability, not
volume. The canary is scheduled from the database (`MAX(started_at) WHERE
canary_count IS NOT NULL`), so a flapping supervisor or repeated
`yarn capture:once` cannot double the budget.

Halving `OBSERVER_POLL_INTERVAL_MS` doubles the first row and nothing else.

## 4. Alerting

Two alarms are mandatory. Both are visible in `/healthz` and in
`api/v1/index.json`'s `freshness` block.

### 4.1 Page on stale capture

```
capture.stale == true      # ageSeconds > CAPTURE_MAX_AGE_SECONDS (default 3600)
```

or equivalently from the shell:

```bash
yarn capture:status   # "Last run" age, status, consecutive unhealthy runs
```

At a 10-minute cadence, one hour without a completed cycle means five missed
samples and a daemon that is not coming back on its own.

### 4.2 Page on zero accounts seen

```
capture.status == "anomaly"     # or freshness.captureLastStatus == "anomaly"
capture.consecutiveFailures > 0 # counts anomaly AND failed
```

This is the alarm that matters most, and the least intuitive one. The primary
query filters on `dataSize = 469`. If the Observation account grows by a single
byte, the query matches **zero** accounts — while succeeding. Without this
alarm the pipeline reports `ok`, the manifest reports fresh, and the accounts
are deleted from the chain in the background. A capture blackout looks exactly
like a quiet network at the transport layer, so it is classified as an
`anomaly` and never as success.

Anomaly codes written to `poll_runs.error`:

| Code | Meaning | Action |
|---|---|---|
| `ZERO_ACCOUNTS` | the query returned nothing | check §5.1 immediately |
| `LAYOUT_DRIFT` | the hourly canary counted more accounts than the sized query | the account layout changed — §5.1, urgent |
| `ALL_ACCOUNTS_UNPARSED` | accounts returned, none decoded | inspect `raw_unparsed`; the SDK or the layout moved |
| `DUPLICATE_OBSERVER_KEYS` | two live accounts claimed one `(epoch, observer)` | investigate on-chain; one of them is being dropped |

### 4.3 Worth a ticket, not a page

- `analysis.stale == true` — the daily run stopped; findings degrade but
  capture is unaffected.
- `observation_revisions` growing steadily — the chain is genuinely updating
  accounts, or something is flapping. Zero is the normal steady state.
- `raw_unparsed` gaining **distinct** rows (`seen_count` climbing on an
  existing row is just the same bad account being re-read).

## 5. Recovery

### 5.1 Zero accounts / layout drift

1. `yarn capture:status` — confirm the last status and error code.
2. Re-run the query by hand with the discriminator filter **only** (no
   `dataSize`). If that returns accounts and the sized query does not, the
   account size changed.
3. Update `OBSERVATION_ACCOUNT_BYTES` and the offsets in `src/capture/decode.ts`
   against the new layout, bump the SDK, run `yarn test`, redeploy.
4. Nothing is lost that was captured before the drift; everything after it is
   gone. This is the one failure worth interrupting a weekend for.

The daemon refuses to start at all if the hardcoded Anchor discriminator stops
matching `sha256('account:Observation')` — a wrong discriminator returns zero
accounts, which is indistinguishable from a quiet network, so it fails loudly
instead.

### 5.2 The daemon will not start: "capture already running"

```
❌ capture already running (pid 3766826 on test-node2, heartbeat 43s ago)
```

If the pid is alive, that is correct behaviour — a second daemon would double
the RPC load and make `poll_runs` unreadable. If the pid is gone, the lock is
taken over automatically on this host. To clear it manually:

```sql
DELETE FROM poll_lock WHERE id = 1;
```

Only ever do this with no capture process running.

### 5.3 Database locked / SQLITE_BUSY

Four processes write the same file, and SQLite serialises writers per **file**,
not per table. WAL plus a 5s busy timeout absorbs the normal case. A cycle that
loses the race logs `database write failed (…); capture continues` and keeps
running — bookkeeping is worth strictly less than staying up. Sustained
contention means an overlapping cadence: stagger the cron entries.

### 5.4 Corrupt or lost database

There is no rebuild. Restore from backup (§6); everything after the backup's
last cycle is unrecoverable. `findings`, `finding_observers` and `public/` are
derived and can be regenerated:

```bash
yarn observers:backfill   # recompute findings over every captured epoch
yarn analyze              # republish the roster and homepage
```

### 5.5 Suspicious findings after a calibration

```bash
sqlite3 data/observations.sqlite "UPDATE calibration SET active = 0;"
yarn observers:findings   # back to capped severity / 0.5 confidence
```

### 5.6 Extending the economics series backwards

`/api/v1/economics.json` normally grows one row per epoch going forward. Past
epochs can also be recovered, because the protocol balance at any past moment
is still on chain: `postTokenBalances` in the metadata of the last transaction
that changed the protocol token account before that moment.

```bash
yarn economics:backfill                     # dry run — reports, writes nothing
yarn economics:backfill --apply
yarn economics:backfill --apply --reanchor  # also correct drift-anchored rows
```

It is a manual command and deliberately not on a timer: the hourly job must
never be able to write history. Safe to re-run — every write is
`INSERT OR IGNORE` on the epoch, so an interrupted run resumes and a finished
one is a no-op.

**It refuses to run unless it can prove the account.** The token account is
hardcoded, so before writing anything it compares that account's current
balance against the `protocolBalance` the live pipeline independently reports
in `portal/summary.json`, and aborts on any difference. Without that check a
wrong address produces a complete, plausible, entirely fictional series rather
than an error. If `summary.json` is missing or stale, fix that first — the
refusal is correct.

Three properties worth knowing before you trust the output:

- Recovered rows carry `null` for `demandFactor`, `circulating`, `staked`,
  `delegated` and `arnsRecordCount`. That PDA state is not in transaction
  metadata, and today's values are not a substitute for it.
- An epoch whose balance cannot be recovered is reported by index and left
  absent. It is never zero-filled or carried forward.
- Prices come from `data/ario-price-daily.csv`, not a live API. An epoch ending
  on date D takes the close of **D−1**, because a daily close for D lands at
  00:00 on D+1. This alignment was verified against CoinGecko's API before the
  file was loaded; one row of drift is worth up to 23% on a single day.

`--reanchor` is the only operation here that overwrites an existing row. It
replaces rows whose `sampled_at` is not their epoch boundary — rows written by
the original sampler, which read the balance whenever the job happened to run.
That drift is not cosmetic: the first row ever written landed 15.4 hours late
and so absorbed 35,725 ARIO of the next epoch's activity. Current code anchors
live samples to the boundary too, so this should only ever be needed once.

Cost is trivial — about 25 RPC calls for a 16-epoch recovery, since signatures
are fetched once and transaction lookups are cached and shared.

### 5.7 Earnings: one perishable half and one replayable half

Two mechanisms feed `/api/v1/rewards.json`, and they fail differently.

**Delegate rewards are replayable.** `CompoundDelegationRewards` emits an event
naming the delegate, gateway and amount. Events live in transaction logs, so
they can be re-derived at any time:

```bash
yarn rewards:backfill            # dry run — reports the epochs it would scan
yarn rewards:backfill --apply
```

Safe to re-run and safe to interrupt: a rescan recomputes identical totals from
immutable logs, so writes are `INSERT OR REPLACE`. The initial 16-epoch backfill
read 2,715 transactions in ~3 minutes using 2,718 RPC calls. The live job scans
at most 2 unscanned epochs per cycle, so steady-state cost is negligible.

An epoch scanned with no events is recorded in `delegate_reward_scans` with
`events = 0`. That distinction matters: without it, an epoch nobody looked at is
indistinguishable from one where nobody earned.

**Operator earnings are NOT replayable, and this is the part that needs
watching.** `DistributeEpoch` emits only an epoch summary — no per-operator
record — so an operator's earnings can only come from `stake_samples` taken
either side of an epoch. Those samples are observations of PDA state, which has
no transaction history. **A missed epoch is lost permanently.**

So if `arns-observer-findings` stops, delegate rewards can be caught up later
but operator earnings for those epochs cannot. Treat a stake-sampling gap the
same way you treat an observation-capture gap. The `🥩 stake:` log line
confirms it ran; `⏭️  stake: skipped` means the portal snapshot was stale and
it will retry, which is fine — repeated skips across an epoch boundary are not.

Sampling costs **zero additional RPC**: positions are read from the portal
snapshot already on disk rather than re-queried.

## 6. Backup

`data/observations.sqlite` is the only irreplaceable artifact in the repository.
Back it up **online**, never by copying the file while the daemon runs:

```bash
sqlite3 data/observations.sqlite ".backup '/backups/observations-$(date -u +%F).sqlite'"
```

Daily is sufficient (epochs are 24h) but hourly costs nothing at this size —
the store grows by roughly 15 KB/epoch of observations, ~170 KB of registry
slot order per epoch, and ~11 KB/epoch of Epoch-account metadata.

Retention: keep everything. The whole point is the longitudinal record; a
`persistent_correlation` finding needs many epochs and a calibration needs at
least 14.

What is safe to delete: `public/`, `reports/`, `findings`,
`finding_observers`, and `poll_runs` rows (auto-pruned after
`POLL_RUN_RETENTION_DAYS`, default 30). What is never safe to delete:
`observations`, `observation_revisions`, `registry_snapshots`,
`registry_slots`, `raw_unparsed`, `epochs`.

### The `epochs` table

One row per epoch, captured from the on-chain Epoch account. It holds the
reward economics (`total_eligible_rewards`, `per_gateway_reward`,
`per_observer_reward`, `reward_rate`) and — more importantly — the protocol's
own tallied verdict:

- `failure_counts` — a raw little-endian `Uint16Array(3000)` blob, indexed by
  gateway **registry slot**, not by address. Join against `registry_slots` for
  the same epoch to resolve a slot to a gateway. Read it back with
  `new Uint16Array(blob.buffer, blob.byteOffset, blob.byteLength / 2)`.
- `has_observed` — a 7-byte bitmap over the 50 prescribed observers, LSB-first.
  Its popcount equals `observations_submitted`, which makes it a free integrity
  check on any row.
- `prescribed_observers`, `prescribed_observer_gateways`,
  `prescribed_name_hashes` — JSON arrays; the name hashes are hex-encoded.

This table is why the gateway no longer needs a raised `CRANK_EPOCH_RETENTION`.
`close_epoch` is permissionless and the effective on-chain retention is the
MINIMUM across every cranker in the network, so no operator can hold epochs
open — the only durable record is the one captured here before the account is
reclaimed. Capture must be running continuously for that to hold; a multi-day
capture outage loses those epochs permanently.

## 7. Health check reference

```bash
curl -s localhost:8787/healthz | jq
```

```jsonc
{
  "status": "ok",              // "degraded" if unpublished, stale, or unhealthy
  "published": true,
  "capture": {
    "status": "ok",            // ok | stale | anomaly | failed | never_run
    "lastRunAt": "…", "ageSeconds": 41,
    "stale": false,
    "accountCount": 35,
    "consecutiveFailures": 0   // anomaly and failed both count
  },
  "analysis": { "status": "ok", "ageSeconds": 2708, "stale": false, "gatewayCount": 18 },
  "uptimeSeconds": 9
}
```

The RPC endpoint never appears here, in the logs, in the database, or in any
published document — only its host is ever printed. If you see a URL anywhere
in this system's output, that is a bug worth reporting.
