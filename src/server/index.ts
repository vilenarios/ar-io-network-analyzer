#!/usr/bin/env node

/**
 * ENTRY POINT (c) — the read-only server.
 *
 * Zero business logic: every route serves a file the publisher already wrote.
 * The database is opened read-only and only for `/healthz` freshness. There is
 * no write path, no query parameter, and no framework.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { assertNodeVersion } from '../utils/runtime.js';
import { tryOpenReader } from '../db/index.js';
import { consecutiveFailedPollRuns, latestAnalysisRun, latestPollRun } from '../db/repo-read.js';
import { isHealthyStatus } from '../capture/status.js';
import type { Manifest } from '../publish/contract.js';
import {
  ARCHIVE_FILE_PATTERN,
  DATE_PATTERN,
  EPOCH_PATTERN,
  cacheControlFor,
  readFile,
  resolveWithin,
} from './static.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_CAPTURE_MAX_AGE_SECONDS = 3_600;
const DEFAULT_ANALYSIS_MAX_AGE_SECONDS = 172_800;
/** /healthz opens a SQLite connection; it is unauthenticated, so cache it. */
const HEALTH_CACHE_MS = 5_000;

/**
 * Sent on every response.
 *
 * `nosniff` is unconditional because the 404 bodies echo the request path, and
 * a sniffing browser is the difference between an inert JSON string and an
 * interpreted document. The report is a single self-contained page with inline
 * scripts, so the CSP cannot forbid inline script — but it can forbid
 * everything the page never needs (remote script, objects, framing, a
 * rewritten base URI), which is what an injected payload would reach for.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

function publicDir(): string {
  return process.env.PUBLIC_DIR || 'public';
}

function envSeconds(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function sendJson(res: ServerResponse, status: number, body: unknown, cacheControl = 'no-store') {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': HTML_CSP,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

interface ManifestCache {
  mtimeMs: number;
  size: number;
  etags: Map<string, string>;
}

let manifestCache: ManifestCache | null = null;

/**
 * Digests from the manifest, reused as ETags so nothing is hashed twice.
 *
 * Memoized on (mtime, size): the manifest grows by one entry per epoch forever
 * and is the document a portal polls every 60 seconds, so re-reading and
 * re-parsing it per request put unbounded synchronous disk I/O on the event
 * loop for an unauthenticated caller.
 */
function manifestEtags(): Map<string, string> {
  const manifestPath = join(publicDir(), 'api/v1/index.json');
  if (!existsSync(manifestPath)) {
    manifestCache = null;
    return new Map();
  }

  let stat;
  try {
    stat = statSync(manifestPath);
  } catch {
    return manifestCache?.etags ?? new Map();
  }

  if (manifestCache && manifestCache.mtimeMs === stat.mtimeMs && manifestCache.size === stat.size) {
    return manifestCache.etags;
  }

  const etags = new Map<string, string>();
  try {
    const raw = readFileSync(manifestPath);
    const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
    for (const entry of Object.values(manifest.documents)) {
      if (!entry) continue;
      if (Array.isArray(entry)) {
        for (const epochEntry of entry) etags.set(epochEntry.path, epochEntry.sha256);
      } else {
        etags.set(entry.path, entry.sha256);
      }
    }
    // The manifest cannot carry its own digest (it would have to contain a
    // hash of itself), and it is the most-polled document of the set — so it
    // is the one that would fall back to a weak mtime ETag. Hash it here,
    // once per publish rather than once per request.
    etags.set('/api/v1/index.json', createHash('sha256').update(raw).digest('hex'));
  } catch {
    // A corrupt manifest costs us ETags, not availability.
  }

  manifestCache = { mtimeMs: stat.mtimeMs, size: stat.size, etags };
  return etags;
}

let healthCache: { at: number; value: { status: number; body: Record<string, unknown> } } | null =
  null;

/** Cached wrapper: /healthz is unauthenticated and opens a SQLite handle. */
function healthzCached(): { status: number; body: Record<string, unknown> } {
  if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.value;
  const value = healthz();
  healthCache = { at: Date.now(), value };
  return value;
}

function healthz(): { status: number; body: Record<string, unknown> } {
  const published = existsSync(join(publicDir(), 'api/v1/index.json'));
  const db = tryOpenReader();

  let capture: Record<string, unknown> = { status: 'unknown' };
  let analysis: Record<string, unknown> = { status: 'unknown' };

  if (db) {
    try {
      const run = latestPollRun(db);
      const captureMaxAge = envSeconds('CAPTURE_MAX_AGE_SECONDS', DEFAULT_CAPTURE_MAX_AGE_SECONDS);
      if (run) {
        const ageSeconds = Math.round((Date.now() - run.startedAt) / 1000);
        capture = {
          status: run.status,
          lastRunAt: new Date(run.startedAt).toISOString(),
          ageSeconds,
          stale: ageSeconds > captureMaxAge,
          accountCount: run.accountCount,
          consecutiveFailures: consecutiveFailedPollRuns(db),
        };
      } else {
        capture = { status: 'never_run', stale: true };
      }

      const analysisRun = latestAnalysisRun(db);
      const analysisMaxAge = envSeconds(
        'ANALYSIS_MAX_AGE_SECONDS',
        DEFAULT_ANALYSIS_MAX_AGE_SECONDS
      );
      if (analysisRun) {
        const ageSeconds = Math.round((Date.now() - analysisRun.startedAt) / 1000);
        analysis = {
          status: analysisRun.status,
          lastRunAt: new Date(analysisRun.startedAt).toISOString(),
          ageSeconds,
          stale: ageSeconds > analysisMaxAge,
          gatewayCount: analysisRun.gatewayCount,
        };
      } else {
        analysis = { status: 'never_run', stale: true };
      }
    } finally {
      db.close();
    }
  }

  // A cycle that completed but captured nothing is recorded as `anomaly`, not
  // `ok`; treating anything other than a healthy status as fine is exactly how
  // a total capture blackout would keep a green light here.
  const degraded =
    !published || capture.stale === true || !isHealthyStatus(String(capture.status ?? ''));
  return {
    status: 200,
    body: {
      status: degraded ? 'degraded' : 'ok',
      published,
      capture,
      analysis,
      // Never the RPC endpoint, never a URL.
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}

/** Map a request path to a file under `public/`, or null when it is not a route. */
export function routeToFile(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';

  const epochMatch = /^\/api\/v1\/epochs\/([^/]+)\.json$/.exec(pathname);
  if (epochMatch) {
    return EPOCH_PATTERN.test(epochMatch[1]) ? `api/v1/epochs/${epochMatch[1]}.json` : null;
  }

  const archiveMatch = /^\/archive\/([^/]+)\/(.*)$/.exec(pathname);
  if (archiveMatch) {
    if (!DATE_PATTERN.test(archiveMatch[1])) return null;
    const rest = archiveMatch[2] === '' ? 'index.html' : archiveMatch[2];
    // The publisher writes exactly three files per archive date. An unbounded
    // `(.*)` served whatever else happened to be in the directory, with an
    // octet-stream fallback; containment held but least privilege did not.
    if (!ARCHIVE_FILE_PATTERN.test(rest)) return null;
    return `archive/${archiveMatch[1]}/${rest}`;
  }

  if (/^\/api\/v1\/(index|network|gateways|observers|findings)\.json$/.test(pathname)) {
    return pathname.slice(1);
  }

  return null;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const isApi = pathname.startsWith('/api/');

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {
      ...SECURITY_HEADERS,
      Allow: 'GET, HEAD',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  if (pathname === '/healthz') {
    const { status, body } = healthzCached();
    sendJson(res, status, body);
    return;
  }

  const relative = routeToFile(pathname);
  if (!relative) {
    if (isApi) sendJson(res, 404, { error: 'not_found', path: pathname });
    else sendHtml(res, 404, '<!doctype html><title>404</title><h1>404 — not found</h1>');
    return;
  }

  const absolute = resolveWithin(publicDir(), relative);
  if (!absolute) {
    sendJson(res, 400, { error: 'invalid_path' });
    return;
  }

  if (!existsSync(join(publicDir(), 'api/v1/index.json'))) {
    // Nothing has ever been published: degraded, but the process stays up.
    if (isApi || pathname === '/') {
      sendJson(res, 503, { error: 'not_published' });
      return;
    }
  }

  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const file = readFile(absolute, acceptsGzip, manifestEtags().get(pathname));
  if (!file) {
    if (isApi) sendJson(res, 404, { error: 'not_found', path: pathname });
    else sendHtml(res, 404, '<!doctype html><title>404</title><h1>404 — not found</h1>');
    return;
  }

  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': file.contentType,
    'Content-Length': String(file.bytes.length),
    'Cache-Control': cacheControlFor(pathname),
    ETag: file.etag,
    Vary: 'Accept-Encoding',
  };
  if (file.contentType.startsWith('text/html')) headers['Content-Security-Policy'] = HTML_CSP;
  if (file.gzipped) headers['Content-Encoding'] = 'gzip';
  if (isApi) headers['Access-Control-Allow-Origin'] = '*';

  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, {
      ...SECURITY_HEADERS,
      ETag: file.etag,
      'Cache-Control': headers['Cache-Control'],
      Vary: 'Accept-Encoding',
    });
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (method === 'HEAD') res.end();
  else res.end(file.bytes);
}

function main(): void {
  assertNodeVersion();

  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = process.env.HOST || DEFAULT_HOST;

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      console.error('request failed:', (error as Error).message);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    }
  });

  server.listen(port, host, () => {
    console.log(`🌐 serving ${publicDir()} on http://${host}:${port}`);
    console.log(`   GET /                      homepage`);
    console.log(`   GET /api/v1/index.json     manifest`);
    console.log(`   GET /api/v1/network.json   network summary`);
    console.log(`   GET /api/v1/gateways.json  gateway roster`);
    console.log(`   GET /api/v1/observers.json observer independence`);
    console.log(`   GET /api/v1/findings.json  findings`);
    console.log(`   GET /api/v1/epochs/<n>.json`);
    console.log(`   GET /archive/<date>/...`);
    console.log(`   GET /healthz`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only listen when run as a program; importing this module (tests do, for the
// routing table) must not bind a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
