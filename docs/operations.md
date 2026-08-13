# Operations runbook — observation capture

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

Cron for the other two cadences:

```cron
*/10 * * * *  cd /opt/ar-io-network-analyzer && yarn observers:findings >> logs/findings.log 2>&1
17   4 * * *  cd /opt/ar-io-network-analyzer && yarn analyze          >> logs/analyze.log 2>&1
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

## 6. Backup

`data/observations.sqlite` is the only irreplaceable artifact in the repository.
Back it up **online**, never by copying the file while the daemon runs:

```bash
sqlite3 data/observations.sqlite ".backup '/backups/observations-$(date -u +%F).sqlite'"
```

Daily is sufficient (epochs are 24h) but hourly costs nothing at this size —
the store grows by roughly 15 KB/epoch of observations plus ~170 KB of registry
slot order per epoch.

Retention: keep everything. The whole point is the longitudinal record; a
`persistent_correlation` finding needs many epochs and a calibration needs at
least 14.

What is safe to delete: `public/`, `reports/`, `findings`,
`finding_observers`, and `poll_runs` rows (auto-pruned after
`POLL_RUN_RETENTION_DAYS`, default 30). What is never safe to delete:
`observations`, `observation_revisions`, `registry_snapshots`,
`registry_slots`, `raw_unparsed`.

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
