#!/usr/bin/env node

/**
 * Load harness for the portal API. Not part of `yarn test` — it is slow, it
 * binds a port, and its pass/fail depends on the machine it runs on.
 *
 * It answers one question: can a small cloud box serve this to a popular site
 * without becoming the new bottleneck? The documents are static and
 * precompressed, so the interesting numbers are request throughput and tail
 * latency, not bandwidth.
 *
 * Usage:
 *   PUBLIC_DIR=<dir with a published snapshot> node --import tsx test/load-test.ts
 *   LOAD_CONCURRENCY=200 LOAD_SECONDS=15 node --import tsx test/load-test.ts
 *
 * Point it at a running server with LOAD_TARGET to measure through nginx:
 *   LOAD_TARGET=https://network.services.ar.io node --import tsx test/load-test.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 100);
const SECONDS = Number(process.env.LOAD_SECONDS || 10);
const PORT = Number(process.env.LOAD_PORT || 8951);
const EXTERNAL = process.env.LOAD_TARGET;
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const SERVER = join(import.meta.dirname, '..', 'src', 'server', 'index.ts');

/** Weighted like a real client: the manifest is polled, documents are not. */
const MIX: Array<{ path: string; weight: number }> = [
  { path: '/api/v1/portal/index.json', weight: 5 },
  { path: '/api/v1/portal/gateways.json', weight: 3 },
  { path: '/api/v1/portal/balances.json', weight: 2 },
  { path: '/api/v1/portal/vaults.json', weight: 1 },
  { path: '/api/v1/portal/delegates.json', weight: 1 },
  { path: '/api/v1/portal/summary.json', weight: 2 },
];

const PICKS: string[] = MIX.flatMap((m) => Array<string>(m.weight).fill(m.path));

interface Stats {
  ok: number;
  notModified: number;
  failed: number;
  bytes: number;
  latencies: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function waitFor(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not listening */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${base} did not become ready`);
}

/**
 * One worker looping until the deadline. Each request is independent; a
 * failure is counted, never retried, because a retry would hide the very
 * saturation this is measuring.
 */
async function worker(
  deadline: number,
  stats: Stats,
  etags: Map<string, string> | null
): Promise<void> {
  let i = 0;
  while (Date.now() < deadline) {
    const path = PICKS[(i += 1) % PICKS.length];
    const known = etags?.get(path);
    const started = performance.now();
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: known ? { 'If-None-Match': known } : undefined,
      });
      const elapsed = performance.now() - started;
      stats.latencies.push(elapsed);

      if (res.status === 304) {
        stats.notModified += 1;
        await res.arrayBuffer();
      } else if (res.ok) {
        stats.ok += 1;
        const tag = res.headers.get('etag');
        if (tag && etags) etags.set(path, tag);
        stats.bytes += (await res.arrayBuffer()).byteLength;
      } else {
        stats.failed += 1;
        await res.arrayBuffer();
      }
    } catch {
      stats.latencies.push(performance.now() - started);
      stats.failed += 1;
    }
  }
}

async function run(label: string, useConditional: boolean): Promise<Stats> {
  const stats: Stats = { ok: 0, notModified: 0, failed: 0, bytes: 0, latencies: [] };
  const deadline = Date.now() + SECONDS * 1000;

  // Warm clients share an ETag map and revalidate. Cold clients pass null and
  // never send If-None-Match — an empty per-worker map is not cold, because a
  // worker caches the tag after its own first request and every subsequent
  // request in the run becomes a 304.
  const shared = new Map<string, string>();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(deadline, stats, useConditional ? shared : null))
  );

  const total = stats.ok + stats.notModified + stats.failed;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const rps = Math.round(total / SECONDS);
  const mib = stats.bytes / 1024 / 1024;

  console.log(`\n── ${label} ─────────────────────────────────`);
  console.log(`  requests      ${total}  (${rps}/s)`);
  console.log(`  200 / 304     ${stats.ok} / ${stats.notModified}`);
  console.log(`  failed        ${stats.failed}`);
  console.log(`  transferred   ${mib.toFixed(1)} MiB  (${(mib / SECONDS).toFixed(1)} MiB/s)`);
  console.log(
    `  latency ms    p50 ${percentile(sorted, 50).toFixed(1)}   ` +
      `p95 ${percentile(sorted, 95).toFixed(1)}   ` +
      `p99 ${percentile(sorted, 99).toFixed(1)}   ` +
      `max ${percentile(sorted, 100).toFixed(1)}`
  );

  return stats;
}

async function main(): Promise<void> {
  let child: ChildProcess | undefined;

  if (!EXTERNAL) {
    if (!process.env.PUBLIC_DIR) {
      console.error('PUBLIC_DIR must point at a directory holding a published snapshot');
      process.exit(2);
    }
    child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
  }

  try {
    await waitFor(BASE);
    console.log(
      `load: ${CONCURRENCY} concurrent clients, ${SECONDS}s per phase, target ${BASE}`
    );

    // Cold: every request downloads a full document. This is the worst case
    // and the one that matters for a first-time visitor.
    const cold = await run('cold clients (no conditional requests)', false);

    // Warm: clients hold ETags and revalidate, which is what a returning
    // browser does and what the cache headers are designed to produce.
    const warm = await run('warm clients (If-None-Match)', true);

    const failures = cold.failed + warm.failed;
    console.log(`\n  total failures: ${failures}`);
    // Set the code and let the process end naturally. `process.exit()` here
    // would skip the cleanup below and orphan the server, which then answers
    // on that port for every later run — including the test suite's.
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    child?.kill('SIGTERM');
  }
}

void main();
