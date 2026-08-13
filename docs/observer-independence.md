# Observer independence — data contract

Everything below is produced by the three processes described in
[operations.md](./operations.md): capture (writes the store), findings
(computes detections), analyze (the daily gateway analysis). The server only
serves files the publisher already wrote.

---

## 1. What is being measured

The AR.IO network selects observers to report on gateway performance each
epoch. If several "independent" observers are in fact one actor, the network's
observation layer is centralized regardless of how many gateway addresses are
registered.

Each epoch, every observer writes an on-chain `Observation` account:

| Field | Type | Notes |
|---|---|---|
| `epochIndex` | u64 | epochs are 24h |
| `observer` | pubkey | **equals** the gateway's `wallet` in the analyzer's data — the join key |
| `gatewayResults` | 375 bytes | a bitmap, one bit per registry slot. **Treated as opaque bytes.** |
| `gatewayCount` | u16 | 643 on mainnet at the time of writing; defines the meaningful prefix |
| `reportTxId` | 43-char base64url | Arweave transaction holding the full gzipped report. **NOT unique.** |
| `submittedAt` | i64 | unix **seconds** |

Three facts drive every design decision in this capability:

1. **`reportTxId` is not unique.** In epoch 511, 17 observations pointed at 11
   distinct reports and **7 observers shared one report transaction**. The
   primary key is therefore `(epochIndex, observer)`, never the report id.
2. **`gatewayResults` is opaque.** Its bit encoding has not been verified
   end-to-end, so nothing here interprets it. It is compared as bytes,
   published verbatim as base64, and annotated with how many of its bytes are
   meaningful. Every v1 detector declares `requiresDecodedResults: false`.
3. **Observations are deleted.** `close_observation` is permissionless and
   sweeps accounts within days. Anything not captured while live is gone
   permanently — see the continuous-capture rule in the runbook.

## 2. Masked Hamming distance

The single new analytical primitive. Four rules, all load-bearing:

- Compare only the first `ceil(gatewayCount / 8)` bytes — 81 of 375 at
  `gatewayCount = 643`. The remaining 294 bytes are constant zero padding;
  including them inflates every score by ~4.6× and makes unrelated observers
  look ~78% alike before any real signal.
- Mask the final partial byte to its low `gatewayCount % 8` bits. Padding bits
  read as `0`, and `0` means "failed" — unmasked padding is a fabricated vote.
- The denominator is **bits** (`gatewayCount`), not bytes and not 3000.
- Zero compared bits scores **0**, not 1. "No evidence" must never present as
  "identical" — that is how a confidence-1.0 finding gets manufactured from an
  empty buffer.

Similarity is quantised: one differing bit is `1/643 ≈ 0.00156`.

## 3. Detectors

Twelve detectors run in a fixed order; #11 and #12 consume the output of the
others. All are pure functions of `DetectorContext` — no I/O, no network, no
clock beyond the injected `now`.

| # | Kind | Evidence | Severity | Confidence | Calibrated? |
|---|---|---|---|---|---|
| 1 | `shared_report_tx` | two or more observers submitted the same `reportTxId` | high (3+), medium (2) | 1.0 | n/a — exact identity |
| 2 | `identical_results` | byte-identical masked result prefixes | high | 1.0 | n/a — exact identity |
| 3 | `near_identical_results` | masked Hamming similarity ≥ threshold | **capped at medium** | **capped at 0.5** | **NO — see §4** |
| 4 | `co_submission_timing` | submissions inside `OBSERVER_CO_SUBMISSION_WINDOW_S` | medium | 0.6 | heuristic |
| 5 | `shared_ip` | observers resolve to one IP address | high | 0.9 | roster-derived |
| 6 | `shared_ip_range` | observers share a /24 | medium | 0.7 | roster-derived |
| 7 | `shared_base_domain` | observers share a registrable domain | medium | 0.8 | roster-derived |
| 8 | `shared_asn` | ≥ `sharedAsnMinObservers` observers in one ASN | low | 0.4 | roster-derived |
| 9 | `analyzer_cluster_overlap` | observers fall in one analyzer cluster | medium | 0.7 | roster-derived |
| 10 | `unmatched_observer` | an observer with no gateway in the roster | info | 0.5 | roster-derived |
| 11 | `composite_independence_risk` | ≥ `compositeMinKinds` distinct evidence families for one group | escalated | derived | derived |
| 12 | `persistent_correlation` | the same group recurs across ≥ `persistentMinEpochs` epochs | escalated | derived | derived |
| — | `detector_error` | a detector threw; the cycle continues | info | 1.0 | n/a |

Detectors 5–10 are **roster-derived**: their evidence comes from the
`gateways.json` the daily analysis publishes. When that file is missing or
older than `ANALYSIS_MAX_AGE_SECONDS`, those findings run *degraded* — severity
capped at medium, confidence × 0.6, and `detail.degraded: true` with the roster
timestamp. The findings process never resolves DNS or geo-locates anything;
degraded mode is the alternative to doing so.

## 4. Why `near_identical_results` is uncalibrated, and what that costs

The 0.90 threshold is a placeholder derived from one epoch of anecdote, and the
measured data says it is almost certainly wrong: at 0.90, **15 of 17 observers
in epoch 511** land in a single connected component (95.5–98.9% similar).
Most observers pass most gateways, so bit-level similarity is naturally very
high network-wide.

Until a calibration row is active, every such finding carries:

```json
{ "calibrated": false, "calibrationId": null, "thresholdProvenance": "uncalibrated-default" }
```

with severity capped at `medium` and confidence at `0.5`. Activating a
calibration promotes it to 0.9 confidence and possible `high`, so:

- `yarn observers:calibrate` refuses to run on fewer than **14** captured
  epochs.
- It measures presumed-independent vs presumed-related pairs and prints the
  distribution, then records an **inactive** row.
- If the most similar presumed-independent pair scores above the median
  presumed-related pair, the row is flagged `NO_SEPARATION` and
  `--activate` **refuses it** — blob similarity has no discriminating power at
  this network size, and promoting it would publish strong accusations derived
  from a metric just measured as useless. `--force` exists and should be
  regarded as a mistake.
- The recommended threshold sits one similarity quantum **above** the most
  similar presumed-independent pair; sitting exactly on it would guarantee that
  pair fires on the first calibrated run.

## 5. HTTP endpoints

`yarn serve` (default `127.0.0.1:8787`) serves published files only. GET/HEAD
only; anything else is `405` with `Allow`. Every response carries
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; HTML also
carries a CSP.

| Route | Content | Cache-Control | ETag |
|---|---|---|---|
| `GET /` | the daily HTML report | `no-store` (404 until an analysis has run) | strong |
| `GET /healthz` | freshness of capture and analysis | `no-store` | — |
| `GET /api/v1/index.json` | manifest: every document, its sha256, freshness | `max-age=30` | strong (sha256) |
| `GET /api/v1/network.json` | network totals, clusters, observer rollup | `max-age=60` | strong |
| `GET /api/v1/gateways.json` | gateway roster with scores and observer join | `max-age=60` | strong |
| `GET /api/v1/observers.json` | per-observer independence summary | `max-age=60` | strong |
| `GET /api/v1/findings.json` | ranked findings with detail | `max-age=60` | strong |
| `GET /api/v1/epochs/<n>.json` | one epoch, including the verbatim blobs | `max-age=300` | strong |
| `GET /archive/<YYYY-MM-DD>/{index.html,gateways.csv,summary.json}` | that day's report | `max-age=86400, immutable` | strong |

ETags come from the manifest's digests (the bodies are not re-hashed per
request), so `If-None-Match` yields a genuine `304`. A precompressed `.gz`
sibling is served when the client sends `Accept-Encoding: gzip`, with its own
ETag suffix so a shared cache cannot hand a gzipped body to a client that did
not ask for one.

The `/api/*` routes send `Access-Control-Allow-Origin: *`. Everything else is
same-origin.

## 6. Document contract (v1)

`index.json` is the polling target and is written **last**, after every other
file has been renamed into place — so a consumer can never read a manifest
whose digests disagree with the files it points at.

```jsonc
// GET /api/v1/index.json
{
  "schemaVersion": "1.x.y",
  "generatedAt": "2026-08-13T17:22:00.000Z",
  "documents": {
    "network":  { "path": "/api/v1/network.json", "sha256": "…", "bytes": 8123, "generatedAt": "…" },
    "gateways": { … },
    "observers": { … },
    "findings": { … },
    "epochs": [ { "epochIndex": 512, "path": "/api/v1/epochs/512.json", "sha256": "…", … } ]
  },
  "freshness": {
    "analysisGeneratedAt": "…", "analysisAgeSeconds": 2708, "analysisStale": false,
    "findingsGeneratedAt": "…",
    "captureLastRunAt": "…", "captureAgeSeconds": 41, "captureStale": false,
    "captureLastStatus": "ok",            // ok | stale | anomaly | failed
    "captureConsecutiveFailures": 0        // counts anomaly AND failed
  },
  "archive": [ { "date": "2026-08-13", "path": "/archive/2026-08-13/" } ]
}
```

Per-observation shape (in `epochs/<n>.json`):

```jsonc
{
  "observer": "…",              // === gateways.json wallet
  "pubkey": "…",                // the account PDA
  "reportTxId": "…",            // 43-char id, NOT unique — never use as a key
  "submittedAtUnix": 1760000000,
  "suspectTimestamp": false,
  "gatewayCount": 643,
  "gatewayResultsBase64": "…",              // all 375 bytes, verbatim
  "gatewayResultsMeaningfulBytes": 81,      // only this prefix carries data
  "gatewayResultsEncoding": "opaque/unverified",  // do NOT interpret the bits
  "revision": 1,                             // bumps only on a real chain change
  "firstSeenAt": "…", "lastSeenAt": "…"
}
```

Epoch-level decodability:

- `registryCaptured: true` — the registry slot order was snapshotted **while
  this epoch was live**. Only then does bit *i* reliably name slot *i*.
- `registryApproximate: true` — a snapshot exists but was taken after the epoch
  closed. Any gateway that joined or left in between shifts every slot after
  it. Treat the bitmap as undecodable.

Finding shape:

```jsonc
{
  "id": "shared_report_tx:511:6f1c2a9b4e07",  // kind:epoch|all:sha256(sorted observers)[0..12]
  "kind": "shared_report_tx",
  "epochIndex": 511,                            // null for window-scoped kinds
  "observers": ["…"],                           // ASCII-sorted
  "severity": "high",                           // info | low | medium | high
  "confidence": 1.0,
  "detectedAt": "…",
  "summary": "7 observers submitted the same report transaction … in epoch 511.",
  "detail": { … }                               // kind-specific; includes calibrated/degraded markers
}
```

Ids are deterministic, so recomputing an epoch produces byte-identical ids and
`first_seen_at` survives. Consumers may treat a finding id as stable.

## 7. Rules for consumers

- **Never key on `reportTxId`.** Key on `(epochIndex, observer)`.
- **Never interpret `gatewayResultsBase64`.** Compare it, count it, display its
  length — do not decode it into per-gateway verdicts. If you need that, wait
  for a detector that declares `requiresDecodedResults: true`, and only for
  epochs with `registryCaptured: true`.
- **Read `calibrated` before quoting a `near_identical_results` finding.**
  `false` means the threshold is a guess and the severity is capped for a
  reason.
- **Poll `index.json`, not the documents.** It carries every digest and the
  freshness block; use `If-None-Match` and only fetch what changed.
- **Check `freshness.captureLastStatus`.** `anomaly` means the last cycle
  completed but captured nothing usable; the data behind it is not advancing.
