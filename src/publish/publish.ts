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
import { consecutiveFailedPollRuns, latestPollRun } from '../db/repo-read.js';
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
const PUBLISH_LOCK_STALE_MS = 300_000;
const PUBLISH_LOCK_HEARTBEAT_MS = 15_000;
/** How long a 'wait' publisher stays quiet before it starts complaining. */
const PUBLISH_LOCK_QUIET_WAIT_MS = 60_000;
/**
 * How long it waits in total. Deliberately longer than the stale window: a
 * live holder finishes in well under a second, and a holder that died mid
 * publish stops heartbeating, so waiting past PUBLISH_LOCK_STALE_MS is what
 * guarantees the daily run eventually publishes instead of silently skipping
 * a day because of a wedged 10-minute cadence.
 */
const PUBLISH_LOCK_MAX_WAIT_MS = PUBLISH_LOCK_STALE_MS + 30_000;

export interface PublishInput {
  network?: NetworkDocument;
  gateways?: GatewaysDocument;
  observers?: ObserversDocument;
  findings?: FindingsDocument;
  epochDocs?: Array<{ epochIndex: number; doc: EpochDocument }>;
  homepage?: { html: string; csv: string; summaryJson: string; date: string };
  archiveDate?: string;
  /**
   * 'wait' (default) blocks up to 60s for the holder to finish — used by the
   * daily run. 'skip' abandons this cycle immediately when the lock is held —
   * used by the 10-minute cadence, which will simply re-run. Neither mode ever
   * evicts a live holder; only a lock whose heartbeat stopped is taken over.
   */
  lock?: 'wait' | 'skip';
}

export function publicDir(): string {
  return resolve(process.env.PUBLIC_DIR || 'public');
}

/**
 * Per-process scratch tree.
 *
 * Two cadences publish. A single shared `public.tmp` meant that whichever
 * publisher finished first deleted the tree the other was still writing into,
 * and its next `renameSync` threw ENOENT — a publish failure caused purely by
 * the other publish succeeding.
 */
function tmpDir(): string {
  return `${publicDir()}.tmp.${process.pid}`;
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

  const startedAt = Date.now();
  const deadline = startedAt + (mode === 'wait' ? PUBLISH_LOCK_MAX_WAIT_MS : 0);
  const pid = process.pid;
  let complained = false;

  for (;;) {
    let acquired = false;
    const attempt = db.transaction(() => {
      const existing = db
        .prepare<
          [],
          { pid: number; heartbeat_at: number }
        >('SELECT pid, heartbeat_at FROM publish_lock WHERE id = 1')
        .get();

      // Staleness is a property of the HOLDER (its heartbeat stopped), never
      // of the waiter's patience. Taking the lock because we got bored would
      // put two publishers in the tree at once, each merging a manifest the
      // other is about to overwrite — the exact invariant this module exists
      // to guarantee.
      const stale = !existing || Date.now() - existing.heartbeat_at > PUBLISH_LOCK_STALE_MS;
      if (existing && !stale) return;

      db.prepare(
        `INSERT INTO publish_lock (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid,
             acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`
      ).run(pid, Date.now(), Date.now());
      acquired = true;
    });
    attempt.immediate();

    if (acquired) {
      // Refresh while we work: a publish slower than PUBLISH_LOCK_STALE_MS
      // would otherwise invalidate its own lock and invite a takeover.
      const beat = setInterval(() => {
        try {
          db.prepare('UPDATE publish_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?').run(
            Date.now(),
            pid
          );
        } catch {
          /* the release path reports real trouble */
        }
      }, PUBLISH_LOCK_HEARTBEAT_MS);
      beat.unref?.();

      return {
        db,
        release: () => {
          clearInterval(beat);
          try {
            db.prepare('DELETE FROM publish_lock WHERE id = 1 AND pid = ?').run(pid);
          } finally {
            db.close();
          }
        },
      };
    }

    if (mode === 'skip' || Date.now() >= deadline) {
      if (mode === 'wait') {
        console.warn(
          `⚠️  publish lock still held after ${Math.round((Date.now() - startedAt) / 1000)}s; ` +
            `giving up rather than publishing alongside another writer`
        );
      }
      db.close();
      return null;
    }

    if (!complained && Date.now() - startedAt > PUBLISH_LOCK_QUIET_WAIT_MS) {
      complained = true;
      console.warn('⚠️  waiting for the publish lock (another cadence is publishing)…');
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
