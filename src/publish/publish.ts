/**
 * The publisher — the only writer of `public/`.
 *
 * Publishing is atomic by construction: every document is written to a scratch
 * tree, fsynced, then `rename()`d into place, and `index.json` is rewritten
 * last. A consumer can therefore never read a manifest whose digests disagree
 * with the files it points at.
 *
 * Two cadences publish (daily `yarn analyze` and 10-minute
 * `yarn observers:findings`), so the manifest is *merged*, never replaced, and
 * a `publish_lock` row keeps them from interleaving.
 */

import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import type { Database } from 'better-sqlite3';
import { openWriter, tryOpenReader } from '../db/index.js';
import {
  consecutiveFailedPollRuns,
  latestPollRun,
  listFindings,
  listEpochs,
} from '../db/repo-read.js';
import type {
  Finding,
  GatewayObserverSummary,
  ObserverIndependenceRollup,
  Severity,
} from '../observers/types.js';
import { SEVERITY_ORDER } from '../observers/types.js';
import {
  SCHEMA_VERSION,
  type DocumentEntry,
  type EpochDocument,
  type FindingsDocument,
  type GatewaysDocument,
  type Manifest,
  type NetworkDocument,
  type ObserversDocument,
} from './contract.js';

const DEFAULT_ANALYSIS_MAX_AGE_SECONDS = 172_800;
const DEFAULT_CAPTURE_MAX_AGE_SECONDS = 3_600;
const PUBLISH_LOCK_WAIT_MS = 60_000;
const PUBLISH_LOCK_STALE_MS = 300_000;

export interface PublishInput {
  network?: NetworkDocument;
  gateways?: GatewaysDocument;
  observers?: ObserversDocument;
  findings?: FindingsDocument;
  epochDocs?: Array<{ epochIndex: number; doc: EpochDocument }>;
  homepage?: { html: string; csv: string; summaryJson: string; date: string };
  archiveDate?: string;
  /**
   * 'wait' (default) blocks up to 60s then takes over a stale lock — used by
   * the daily run. 'skip' abandons this cycle when the lock is held — used by
   * the 10-minute cadence, which will simply re-run.
   */
  lock?: 'wait' | 'skip';
}

export function publicDir(): string {
  return resolve(process.env.PUBLIC_DIR || 'public');
}

function tmpDir(): string {
  return `${publicDir()}.tmp`;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Write one file atomically: scratch tree -> fsync -> rename into place. */
function writeAtomic(relativePath: string, content: string | Buffer): void {
  const target = join(publicDir(), relativePath);
  const scratch = join(tmpDir(), relativePath);

  mkdirSync(dirname(scratch), { recursive: true });
  mkdirSync(dirname(target), { recursive: true });

  writeFileSync(scratch, content);
  const fd = openSync(scratch, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(scratch, target);
}

/**
 * Write a document plus its precompressed sibling, and return the manifest
 * entry. The digest is of the uncompressed bytes — the server reuses it as an
 * ETag rather than hashing again.
 */
function writeDocument(relativePath: string, value: unknown, generatedAt: string): DocumentEntry {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  writeAtomic(relativePath, json);
  writeAtomic(`${relativePath}.gz`, gzipSync(Buffer.from(json)));

  return {
    path: `/${relativePath}`,
    sha256: sha256(json),
    bytes: Buffer.byteLength(json),
    generatedAt,
  };
}

function readManifest(): Manifest | null {
  const path = join(publicDir(), 'api/v1/index.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Read a previously published document. Returns null when absent or corrupt. */
export function readPublishedDocument<T>(relativePath: string): T | null {
  const path = join(publicDir(), relativePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function envSeconds(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Freshness is read from the database; it is the only DB read in publishing. */
function buildFreshness(analysisGeneratedAt: string | null, findingsGeneratedAt: string | null) {
  const now = Date.now();
  const analysisMaxAge = envSeconds('ANALYSIS_MAX_AGE_SECONDS', DEFAULT_ANALYSIS_MAX_AGE_SECONDS);
  const captureMaxAge = envSeconds('CAPTURE_MAX_AGE_SECONDS', DEFAULT_CAPTURE_MAX_AGE_SECONDS);

  let captureLastRunAt: string | null = null;
  let captureAgeSeconds: number | null = null;
  let captureLastStatus: string | null = null;
  let captureConsecutiveFailures: number | null = null;

  const db = tryOpenReader();
  if (db) {
    try {
      const run = latestPollRun(db);
      if (run) {
        captureLastRunAt = new Date(run.startedAt).toISOString();
        captureAgeSeconds = Math.round((now - run.startedAt) / 1000);
        captureLastStatus = run.status;
      }
      captureConsecutiveFailures = consecutiveFailedPollRuns(db);
    } finally {
      db.close();
    }
  }

  const analysisAgeSeconds = analysisGeneratedAt
    ? Math.round((now - Date.parse(analysisGeneratedAt)) / 1000)
    : null;

  return {
    analysisGeneratedAt,
    analysisAgeSeconds,
    analysisStale: analysisAgeSeconds === null || analysisAgeSeconds > analysisMaxAge,
    findingsGeneratedAt,
    captureLastRunAt,
    captureAgeSeconds,
    captureStale: captureAgeSeconds === null || captureAgeSeconds > captureMaxAge,
    captureLastStatus,
    captureConsecutiveFailures,
  };
}

interface PublishLockHandle {
  db: Database | null;
  release(): void;
}

const sleep = (ms: number) => new Promise((resolve_) => setTimeout(resolve_, ms));

async function acquirePublishLock(mode: 'wait' | 'skip'): Promise<PublishLockHandle | null> {
  let db: Database;
  try {
    db = openWriter();
  } catch {
    // No database is not a reason to refuse to publish — the daily analysis
    // can run on a box that has never captured.
    console.warn('⚠️  publish lock unavailable (no database); publishing unguarded');
    return { db: null, release: () => {} };
  }

  const deadline = Date.now() + (mode === 'wait' ? PUBLISH_LOCK_WAIT_MS : 0);
  const pid = process.pid;

  for (;;) {
    let acquired = false;
    const attempt = db.transaction(() => {
      const existing = db
        .prepare<
          [],
          { pid: number; heartbeat_at: number }
        >('SELECT pid, heartbeat_at FROM publish_lock WHERE id = 1')
        .get();

      const stale = !existing || Date.now() - existing.heartbeat_at > PUBLISH_LOCK_STALE_MS;
      const expired = mode === 'wait' && Date.now() >= deadline;

      if (existing && !stale && !expired) return;

      db.prepare(
        `INSERT INTO publish_lock (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid,
             acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`
      ).run(pid, Date.now(), Date.now());
      acquired = true;
    });
    attempt.immediate();

    if (acquired) {
      return {
        db,
        release: () => {
          try {
            db.prepare('DELETE FROM publish_lock WHERE id = 1 AND pid = ?').run(pid);
          } finally {
            db.close();
          }
        },
      };
    }

    if (mode === 'skip' || Date.now() >= deadline) {
      db.close();
      return null;
    }

    // Coarse polling; publishing is a once-per-cadence operation.
    await sleep(1000);
  }
}

/**
 * Publish a partial set of documents, merging into whatever is already there.
 * Resolves without publishing when the lock is held and `lock: 'skip'`.
 */
export async function publishDocuments(input: PublishInput): Promise<void> {
  const lock = await acquirePublishLock(input.lock ?? 'wait');
  if (!lock) {
    console.log(
      '⏭️  publish skipped — another cadence holds the publish lock; will retry next run'
    );
    return;
  }

  try {
    const generatedAt = new Date().toISOString();
    const previous = readManifest();
    const documents: Manifest['documents'] = { ...(previous?.documents ?? {}) };
    const archive = [...(previous?.archive ?? [])];

    if (input.network) {
      documents.network = writeDocument('api/v1/network.json', input.network, generatedAt);
    }
    if (input.gateways) {
      documents.gateways = writeDocument('api/v1/gateways.json', input.gateways, generatedAt);
    }
    if (input.observers) {
      documents.observers = writeDocument('api/v1/observers.json', input.observers, generatedAt);
    }
    if (input.findings) {
      documents.findings = writeDocument('api/v1/findings.json', input.findings, generatedAt);
    }
    if (input.epochDocs && input.epochDocs.length > 0) {
      const byIndex = new Map<number, DocumentEntry & { epochIndex: number }>(
        (documents.epochs ?? []).map((entry) => [entry.epochIndex, entry])
      );
      for (const { epochIndex, doc } of input.epochDocs) {
        const entry = writeDocument(`api/v1/epochs/${epochIndex}.json`, doc, generatedAt);
        byIndex.set(epochIndex, { ...entry, epochIndex });
      }
      documents.epochs = [...byIndex.values()].sort((a, b) => b.epochIndex - a.epochIndex);
    }

    if (input.homepage) {
      const date = input.archiveDate || input.homepage.date;
      writeAtomic('index.html', input.homepage.html);
      writeAtomic(`archive/${date}/index.html`, input.homepage.html);
      writeAtomic(`archive/${date}/gateways.csv`, input.homepage.csv);
      writeAtomic(`archive/${date}/summary.json`, input.homepage.summaryJson);
      if (!archive.some((a) => a.date === date)) {
        archive.push({ date, path: `/archive/${date}/` });
      }
      archive.sort((a, b) => (a.date < b.date ? 1 : -1));
    }

    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      documents,
      freshness: buildFreshness(
        documents.network?.generatedAt ?? previous?.freshness.analysisGeneratedAt ?? null,
        documents.findings?.generatedAt ?? previous?.freshness.findingsGeneratedAt ?? null
      ),
      archive,
    };

    // Manifest last, always.
    writeDocument('api/v1/index.json', manifest, generatedAt);

    // The scratch tree is disposable once every rename has landed.
    rmSync(tmpDir(), { recursive: true, force: true });

    console.log(`📦 published to ${publicDir()}`);
  } finally {
    lock.release();
  }
}

export interface ObserverPublishContext {
  rollup: ObserverIndependenceRollup | null;
  byGateway: Map<string, GatewayObserverSummary>;
  /** Ranked findings for the HTML report's Observers tab; empty hides the tab. */
  findings: Finding[];
}

/**
 * Join observer findings onto the gateway roster for the daily analysis.
 * Returns empty context when no observations have been captured yet.
 */
export function loadObserverContext(): ObserverPublishContext {
  const empty: ObserverPublishContext = { rollup: null, byGateway: new Map(), findings: [] };
  const db = tryOpenReader();
  if (!db) return empty;

  try {
    const epochs = listEpochs(db);
    if (epochs.length === 0) return empty;

    const findings = listFindings(db);
    const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0 };
    const byKind: Record<string, number> = {};
    const byGateway = new Map<string, GatewayObserverSummary>();

    for (const row of db
      .prepare<[], { observer: string; epochs: number; first_epoch: number; last_epoch: number }>(
        `SELECT observer, COUNT(*) AS epochs, MIN(epoch_index) AS first_epoch,
                MAX(epoch_index) AS last_epoch
           FROM observations GROUP BY observer`
      )
      .all()) {
      byGateway.set(row.observer, {
        observer: row.observer,
        epochsObserved: row.epochs,
        firstEpochIndex: row.first_epoch,
        lastEpochIndex: row.last_epoch,
        findingCount: 0,
        maxSeverity: null,
        kinds: [],
      });
    }

    for (const finding of findings) {
      bySeverity[finding.severity]++;
      byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;

      for (const observer of finding.observers) {
        const summary = byGateway.get(observer);
        if (!summary) continue;
        summary.findingCount++;
        if (!summary.kinds.includes(finding.kind)) summary.kinds.push(finding.kind);
        if (
          summary.maxSeverity === null ||
          SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(summary.maxSeverity)
        ) {
          summary.maxSeverity = finding.severity;
        }
      }
    }

    const calibrated = findings.some(
      (f) => f.kind === 'near_identical_results' && f.detail.calibrated === true
    );

    const ranked: Finding[] = findings
      .slice()
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
          b.confidence - a.confidence ||
          (b.epochIndex ?? Number.MAX_SAFE_INTEGER) - (a.epochIndex ?? Number.MAX_SAFE_INTEGER)
      );

    const rollup: ObserverIndependenceRollup = {
      generatedAt: new Date().toISOString(),
      epochRange: {
        from: epochs[0].epochIndex,
        to: epochs[epochs.length - 1].epochIndex,
        count: epochs.length,
      },
      observerCount: byGateway.size,
      findingCount: findings.length,
      bySeverity,
      byKind,
      calibrated,
      topFindings: ranked.slice(0, 20).map((f) => ({
        id: f.id,
        kind: f.kind,
        epochIndex: f.epochIndex,
        severity: f.severity,
        confidence: f.confidence,
        observerCount: f.observers.length,
        summary: f.summary,
      })),
    };

    return { rollup, byGateway, findings: ranked };
  } catch {
    return empty;
  } finally {
    db.close();
  }
}
