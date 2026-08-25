/**
 * Ordered DDL for the observation store.
 *
 * Migrations are append-only: never edit a shipped version, add a new one.
 * They are applied by whichever writer opens the file first, inside a
 * BEGIN IMMEDIATE transaction, so two writers racing at boot is safe.
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'observations',
    statements: [
      `CREATE TABLE IF NOT EXISTS observations (
        epoch_index        INTEGER NOT NULL,
        observer           TEXT    NOT NULL,
        pubkey             TEXT    NOT NULL,
        gateway_results    BLOB    NOT NULL,
        gateway_count      INTEGER NOT NULL,
        report_tx_id       TEXT    NOT NULL,
        submitted_at       INTEGER NOT NULL,
        schema_major       INTEGER,
        schema_minor       INTEGER,
        schema_patch       INTEGER,
        account_bytes      INTEGER NOT NULL,
        suspect_timestamp  INTEGER NOT NULL DEFAULT 0,
        revision           INTEGER NOT NULL DEFAULT 1,
        first_seen_at      INTEGER NOT NULL,
        last_seen_at       INTEGER NOT NULL,
        first_seen_slot    INTEGER NOT NULL,
        last_seen_slot     INTEGER NOT NULL,
        PRIMARY KEY (epoch_index, observer)
      ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS idx_obs_report ON observations(report_tx_id)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_epoch ON observations(epoch_index)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_observer ON observations(observer)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_submitted ON observations(epoch_index, submitted_at)`,

      `CREATE TABLE IF NOT EXISTS observation_revisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch_index      INTEGER NOT NULL,
        observer         TEXT    NOT NULL,
        revision         INTEGER NOT NULL,
        gateway_results  BLOB    NOT NULL,
        gateway_count    INTEGER NOT NULL,
        report_tx_id     TEXT    NOT NULL,
        submitted_at     INTEGER NOT NULL,
        pubkey           TEXT    NOT NULL,
        superseded_at    INTEGER NOT NULL,
        superseded_slot  INTEGER NOT NULL,
        changed_fields   TEXT    NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rev_key ON observation_revisions(epoch_index, observer)`,

      `CREATE TABLE IF NOT EXISTS registry_snapshots (
        epoch_index      INTEGER PRIMARY KEY,
        gateway_count    INTEGER NOT NULL,
        captured_at      INTEGER NOT NULL,
        captured_at_slot INTEGER NOT NULL,
        registry_pubkey  TEXT    NOT NULL,
        digest           TEXT    NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS registry_slots (
        epoch_index     INTEGER NOT NULL,
        slot_index      INTEGER NOT NULL,
        gateway_address TEXT    NOT NULL,
        PRIMARY KEY (epoch_index, slot_index),
        FOREIGN KEY (epoch_index) REFERENCES registry_snapshots(epoch_index)
      ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS idx_slots_addr ON registry_slots(gateway_address)`,

      `CREATE TABLE IF NOT EXISTS raw_unparsed (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey      TEXT    NOT NULL,
        data_b64    TEXT    NOT NULL,
        byte_length INTEGER NOT NULL,
        reason      TEXT    NOT NULL,
        seen_at     INTEGER NOT NULL,
        seen_slot   INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS poll_runs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at         INTEGER NOT NULL,
        finished_at        INTEGER,
        context_slot       INTEGER,
        account_count      INTEGER,
        inserted_count     INTEGER,
        updated_count      INTEGER,
        revision_count     INTEGER,
        unparsed_count     INTEGER,
        canary_count       INTEGER,
        status             TEXT NOT NULL,
        error              TEXT,
        duration_ms        INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_poll_started ON poll_runs(started_at DESC)`,

      `CREATE TABLE IF NOT EXISTS poll_lock (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        pid          INTEGER NOT NULL,
        host         TEXT    NOT NULL,
        acquired_at  INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS publish_lock (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        pid          INTEGER NOT NULL,
        acquired_at  INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS analysis_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        gateway_count  INTEGER,
        resolved_count INTEGER,
        cluster_count  INTEGER,
        status         TEXT NOT NULL,
        error          TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS findings (
        id             TEXT PRIMARY KEY,
        kind           TEXT    NOT NULL,
        epoch_index    INTEGER,
        severity       TEXT    NOT NULL,
        confidence     REAL    NOT NULL,
        observer_count INTEGER NOT NULL,
        summary        TEXT    NOT NULL,
        detail_json    TEXT    NOT NULL,
        detected_at    INTEGER NOT NULL,
        first_seen_at  INTEGER NOT NULL,
        detector_version INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_find_epoch ON findings(epoch_index)`,
      `CREATE INDEX IF NOT EXISTS idx_find_kind ON findings(kind)`,

      `CREATE TABLE IF NOT EXISTS finding_observers (
        finding_id TEXT NOT NULL,
        observer   TEXT NOT NULL,
        PRIMARY KEY (finding_id, observer),
        FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
      ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS idx_fobs_observer ON finding_observers(observer)`,

      `CREATE TABLE IF NOT EXISTS calibration (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        computed_at        INTEGER NOT NULL,
        epoch_from         INTEGER NOT NULL,
        epoch_to           INTEGER NOT NULL,
        epoch_count        INTEGER NOT NULL,
        pair_count         INTEGER NOT NULL,
        independent_pairs  INTEGER NOT NULL,
        p50 REAL, p90 REAL, p99 REAL, p995 REAL, p999 REAL, max_independent REAL,
        recommended_threshold REAL NOT NULL,
        active             INTEGER NOT NULL DEFAULT 0,
        notes              TEXT
      )`,
    ],
  },
  {
    version: 2,
    name: 'provenance-and-guards',
    statements: [
      // M4: a registry snapshot taken while its epoch was still live is
      // authoritative; one taken for an epoch that had already elapsed is an
      // approximation and must never be presented as decodable slot order.
      `ALTER TABLE registry_snapshots ADD COLUMN in_epoch INTEGER NOT NULL DEFAULT 0`,

      // L2: park the same undecodable bytes once, not once per cycle.
      `ALTER TABLE raw_unparsed ADD COLUMN data_sha256 TEXT`,
      `ALTER TABLE raw_unparsed ADD COLUMN seen_count INTEGER`,
      `ALTER TABLE raw_unparsed ADD COLUMN last_seen_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_raw_dedupe ON raw_unparsed(pubkey, data_sha256)`,

      // M5: whether the calibration run found any separating signal at all.
      // 1 = separates, 0 = NO_SEPARATION, NULL = undetermined.
      `ALTER TABLE calibration ADD COLUMN separates INTEGER`,

      `CREATE INDEX IF NOT EXISTS idx_poll_status ON poll_runs(status, started_at DESC)`,
    ],
  },
  {
    version: 3,
    name: 'epoch-accounts',
    statements: [
      // The Epoch account holds the reward economics AND the tallied network
      // verdict: failure_counts is the per-gateway failure tally the protocol
      // itself computed, and has_observed is the bitmap of which prescribed
      // observers actually submitted. None of it survives close_epoch, and
      // close_epoch is permissionless — no operator controls how long it
      // stays readable. Capturing it here is what makes it safe to stop
      // trying to hold epochs open on chain.
      //
      // Keyed on epoch_index alone: exactly one Epoch account per epoch,
      // unlike observations which are per (epoch, observer).
      `CREATE TABLE IF NOT EXISTS epochs (
        epoch_index                  INTEGER PRIMARY KEY,
        start_timestamp              INTEGER,
        end_timestamp                INTEGER,
        total_eligible_rewards       INTEGER,
        per_gateway_reward           INTEGER,
        per_observer_reward          INTEGER,
        reward_rate                  INTEGER,
        active_gateway_count         INTEGER,
        observer_count               INTEGER,
        name_count                   INTEGER,
        observations_submitted       INTEGER,
        rewards_distributed          INTEGER,
        weights_tallied              INTEGER,
        prescriptions_done           INTEGER,
        distribution_index           INTEGER,
        tally_index                  INTEGER,
        -- Uint16Array(3000) little-endian: the protocol's own failure tally,
        -- indexed by gateway registry slot. Join against registry_slots for
        -- the same epoch to resolve a slot to a gateway.
        failure_counts               BLOB,
        -- 7-byte bitmap over the prescribed observers, LSB-first.
        has_observed                 BLOB,
        prescribed_observers         TEXT,
        prescribed_observer_gateways TEXT,
        prescribed_name_hashes       TEXT,
        account_bytes                INTEGER NOT NULL,
        first_seen_at                INTEGER NOT NULL,
        last_seen_at                 INTEGER NOT NULL,
        first_seen_slot              INTEGER,
        last_seen_slot               INTEGER
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_epochs_seen ON epochs(last_seen_at DESC)`,
    ],
  },
  {
    version: 4,
    name: 'epoch-provenance',
    statements: [
      // Who paid to create each epoch. `CreateEpoch` costs ~0.066 SOL and the
      // refund goes to whoever CLOSES the epoch, not whoever created it -- so
      // the creator is subsidising the closer. This node only creates when no
      // one else has (its crank reaches the create step ~16 min after the
      // boundary, while other crankers get there in ~8), but that delay is an
      // emergent property of the pipeline backlog, not a configured one. If
      // the backlog ever shrinks this node silently starts paying again.
      //
      // Recording the creator turns that from an invisible balance drift into
      // something observable. Resolved once per epoch (it never changes), via
      // the oldest signature on the Epoch PDA.
      `ALTER TABLE epochs ADD COLUMN pubkey TEXT`,
      `ALTER TABLE epochs ADD COLUMN created_by TEXT`,
      `ALTER TABLE epochs ADD COLUMN created_at INTEGER`,
      `ALTER TABLE epochs ADD COLUMN create_lag_seconds INTEGER`,
    ],
  },
  {
    version: 5,
    name: 'economics-samples',
    statements: [
      // One row per COMPLETED epoch, capturing the protocol balance so a delta
      // can be taken across it.
      //
      // The balance is recomputed on every publish cycle and immediately
      // discarded, so only one sample has ever existed at a time and no delta
      // was derivable. Nothing new is measured here — the missing capability
      // was retention.
      //
      // `epoch_index` is the primary key, so a sample is written once and never
      // revised. Re-running the sampler is a no-op, which is what makes this an
      // append-only series rather than "whatever the last run happened to see".
      //
      // Deliberately absent: any derived column. Net inflow is
      // `delta(protocol_balance) + total_eligible_rewards`, and storing it would
      // bake in an attribution the balance does not support — it moves for
      // reasons beyond ArNS revenue. Components are stored; consumers subtract.
      `CREATE TABLE IF NOT EXISTS economics_samples (
         epoch_index            INTEGER PRIMARY KEY,
         sampled_at             INTEGER NOT NULL,
         slot                   INTEGER,
         protocol_balance       INTEGER NOT NULL,
         total_eligible_rewards INTEGER,
         demand_factor          REAL,
         circulating            INTEGER,
         staked                 INTEGER,
         delegated              INTEGER,
         arns_record_count      INTEGER,
         -- Off-chain price, kept as its own nullable component with provenance.
         -- Everything else in this row is read from chain; this is not, and a
         -- consumer deserves to know which is which. Publishing a USD-denominated
         -- FIELD would hide that seam, so the price is published and the
         -- multiplication is left to the caller.
         --
         -- Nullable independently of the row: a third-party outage must never
         -- cost us the on-chain sample, which is the part that cannot be
         -- re-read later.
         ario_price_usd         REAL,
         ario_price_source      TEXT,
         ario_price_at          INTEGER
       )`,
    ],
  },
  {
    version: 6,
    name: 'ario-daily-price',
    statements: [
      // Daily ARIO close price, keyed by UTC date.
      //
      // Separate from `economics_samples` because it is a different KIND of
      // fact: off-chain, third-party, and reusable beyond the economics series
      // (denominating historical ArNS registrations needs the same table).
      //
      // `close_date` is the day the price CLOSED, which is not the same as the
      // day CoinGecko's `/history?date=D` reports it under: that endpoint
      // returns the 00:00 snapshot of D, which is the close of D-1. Storing
      // the close date rather than the query date keeps the ambiguity out of
      // every consumer. An epoch ending on date D at 00:04 UTC therefore takes
      // the row for D-1.
      //
      // Verified against the live API on two dates before any data was loaded:
      // the alignment is real, and a one-row error is worth up to 23% on a
      // single day of this series.
      `CREATE TABLE IF NOT EXISTS ario_price_daily (
         close_date TEXT PRIMARY KEY,
         price_usd  REAL NOT NULL,
         source     TEXT NOT NULL,
         loaded_at  INTEGER NOT NULL
       )`,
    ],
  },
  {
    version: 7,
    name: 'stake-samples',
    statements: [
      // One row per staking POSITION per settled epoch.
      //
      // WHY THIS TABLE HAS TO EXIST. Rewards compound directly into stake —
      // 98.4% of delegations carry sub-ARIO precision and the large ones sit
      // just above round numbers (2,000,000 staked, 2,016,682.247752 held).
      // Nothing on chain records what a position has EARNED; only what it
      // currently holds. So earnings are a difference between two observations,
      // and without retention there is only ever one observation.
      //
      // AND WHY IT CANNOT WAIT. `DistributeEpoch` moves rewards into a
      // program-owned custody account and credits positions in PDA state, which
      // has no per-transaction history. Unlike the protocol balance — recovered
      // from `postTokenBalances` — a stake at a past epoch is NOT recoverable
      // afterwards. Every epoch that passes unsampled is permanently lost.
      //
      // `kind` distinguishes an operator's own stake from a delegation.
      // Operators were the obvious omission the first time this was scoped:
      // they hold 8.7M ARIO against delegates' 10.0M.
      //
      // The key is (epoch, kind, address, gateway) because one wallet may
      // delegate to many gateways, and each delegation earns separately.
      `CREATE TABLE IF NOT EXISTS stake_samples (
         epoch_index     INTEGER NOT NULL,
         kind            TEXT    NOT NULL,
         address         TEXT    NOT NULL,
         gateway_address TEXT    NOT NULL,
         staked          INTEGER NOT NULL,
         vaulted         INTEGER NOT NULL,
         start_timestamp INTEGER,
         sampled_at      INTEGER NOT NULL,
         PRIMARY KEY (epoch_index, kind, address, gateway_address)
       )`,
      // Reading one position's history across epochs is the query the portal
      // makes for "what have I earned"; without this it is a full scan.
      `CREATE INDEX IF NOT EXISTS idx_stake_samples_position
         ON stake_samples (kind, address, gateway_address, epoch_index)`,
    ],
  },
  {
    version: 8,
    name: 'delegate-rewards',
    statements: [
      // Exact per-delegation rewards, decoded from CompoundDelegationRewards
      // events rather than inferred from stake movement.
      //
      // Separate from `stake_samples` because it is a different kind of fact
      // with different guarantees: a sample is an observation that can never be
      // recovered if missed, whereas these events live in transaction logs and
      // can be re-derived from chain history at any time. Conflating them would
      // hide that a row here is replayable and a row there is not.
      //
      // `amount` is what the program actually credited, so no deposit or
      // withdrawal can be mistaken for earnings — the failure mode of deriving
      // rewards from a stake delta.
      `CREATE TABLE IF NOT EXISTS delegate_rewards (
         epoch_index INTEGER NOT NULL,
         delegate    TEXT    NOT NULL,
         gateway     TEXT    NOT NULL,
         amount      INTEGER NOT NULL,
         event_count INTEGER NOT NULL,
         first_at    INTEGER NOT NULL,
         last_at     INTEGER NOT NULL,
         PRIMARY KEY (epoch_index, delegate, gateway)
       )`,
      // "What have I earned" is a per-delegate scan across epochs.
      `CREATE INDEX IF NOT EXISTS idx_delegate_rewards_delegate
         ON delegate_rewards (delegate, epoch_index)`,
      // Records which epochs have been scanned, so an epoch with genuinely zero
      // rewards is distinguishable from one never looked at. Without this an
      // unscanned epoch reads as "earned nothing".
      `CREATE TABLE IF NOT EXISTS delegate_reward_scans (
         epoch_index  INTEGER PRIMARY KEY,
         scanned_at   INTEGER NOT NULL,
         events       INTEGER NOT NULL,
         transactions INTEGER NOT NULL
       )`,
    ],
  }

];

/**
 * Apply every migration newer than the recorded schema version.
 * Safe to call on every open; a no-op once current.
 */
export function applyMigrations(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((r) => r.version)
  );

  let count = 0;
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      record.run(migration.version, Date.now());
    });
    run.immediate();
    count++;
  }

  return count;
}

/** Current schema version recorded in the file (0 when nothing applied yet). */
export function currentSchemaVersion(db: Database): number {
  const row = db
    .prepare<
      [],
      { version: number | null }
    >(`SELECT MAX(version) AS version FROM schema_migrations`)
    .get();
  return row?.version ?? 0;
}

async function main(): Promise<void> {
  const { assertNodeVersion } = await import('../utils/runtime.js');
  assertNodeVersion();

  const { openWriter, resolveDbPath } = await import('./index.js');
  const args = process.argv.slice(2);

  if (args.includes('--stats')) {
    const db = openWriter();
    const tables = db
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all();
    console.log(`Database: ${resolveDbPath()}`);
    console.log(`Schema version: ${currentSchemaVersion(db)}\n`);
    for (const { name } of tables) {
      const { n } = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
        n: number;
      };
      console.log(`  ${name.padEnd(24)} ${n}`);
    }
    db.close();
    return;
  }

  // Default (and --apply): open the writer, which migrates on open.
  const db = openWriter();
  console.log(`Database: ${resolveDbPath()}`);
  console.log(`Schema version: ${currentSchemaVersion(db)}`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
}
