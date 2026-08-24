#!/usr/bin/env node

/**
 * ENTRY POINT — the portal snapshot publisher.
 *
 * One cycle is: scan the chain five times, project the results, write six
 * files. It holds no database, signs nothing, and serves nothing.
 *
 * Deliberately unlocked. The capture daemon takes a lock because a missed
 * observation is unrecoverable; here every document is re-derivable from chain
 * at any moment, each write is atomic (scratch -> fsync -> rename), and
 * systemd already runs one instance per environment. Adding a lock would buy
 * nothing and reintroduce the stale-lock failure mode documented in
 * docs/operations.md §5.2.
 *
 * A failed cycle never exits the process and never clears the documents. It
 * annotates the manifest so consumers can see the data has stopped moving, and
 * tries again on the next tick.
 */

import { fetchPortalSnapshot } from './fetch.js';
import { markPortalPublishFailure, publishPortalDocuments, readPortalManifest } from '../publish/portal.js';
import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { publicDir } from '../publish/publish.js';

const DEFAULT_INTERVAL_MS = 600_000; // 10 minutes

export function intervalMs(): number {
  const raw = parseInt(process.env.PORTAL_POLL_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

/** How stale the manifest may be before `--status` calls it unhealthy. */
export function maxAgeSeconds(): number {
  const raw = parseInt(process.env.PORTAL_MAX_AGE_SECONDS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  // Two cycles plus slack: one missed tick is normal, two is a problem.
  return Math.round((intervalMs() / 1000) * 2.5);
}

export interface CycleResult {
  ok: boolean;
  counts?: Record<string, number>;
  error?: string;
}

/** One publish cycle. Never throws — the caller decides whether to keep going. */
export async function runCycle(): Promise<CycleResult> {
  try {
    const snapshot = await fetchPortalSnapshot();

    // A scan that returns zero gateways is not a quiet network; it is a
    // filter that stopped matching, an endpoint returning empty results, or a
    // wrong program id. Publishing it would replace good documents with an
    // empty set, so refuse and keep what is already on disk.
    if (snapshot.gateways.length === 0) {
      return {
        ok: false,
        error: 'refusing to publish: the gateway scan returned zero accounts',
      };
    }

    publishPortalDocuments(snapshot);

    return {
      ok: true,
      counts: {
        gateways: snapshot.gateways.length,
        vaults: snapshot.vaults.length,
        balances: snapshot.balances.length,
        delegates: snapshot.delegates.length,
        arnsRecords: snapshot.arnsRecordCount,
      },
    };
  } catch (error) {
    // scrubSecrets, not `.message`: a malformed SOLANA_RPC_URL makes fetch
    // throw with the whole URL — token included — inside the message.
    return { ok: false, error: scrubSecrets(error) };
  }
}

function describe(result: CycleResult): string {
  if (!result.ok) return `failed: ${result.error}`;
  const counts = result.counts ?? {};
  return Object.entries(counts)
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');
}

/** `--status`: read-only freshness summary. Exit code 1 when unhealthy. */
function status(): number {
  const manifest = readPortalManifest();
  if (!manifest) {
    console.log(JSON.stringify({ status: 'never_published', publicDir: publicDir() }, null, 2));
    return 1;
  }

  const ageSeconds = Math.round((Date.now() - Date.parse(manifest.generatedAt)) / 1000);
  const stale = ageSeconds > maxAgeSeconds();
  const body = {
    status: stale ? 'stale' : 'ok',
    network: manifest.network,
    generatedAt: manifest.generatedAt,
    ageSeconds,
    maxAgeSeconds: maxAgeSeconds(),
    consecutiveFailures: manifest.freshness?.consecutiveFailures ?? 0,
    documents: Object.fromEntries(
      Object.entries(manifest.documents ?? {}).map(([name, entry]) => [name, entry?.bytes ?? null])
    ),
  };
  console.log(JSON.stringify(body, null, 2));
  return stale ? 1 : 0;
}

async function main(): Promise<void> {
  assertNodeVersion();

  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    process.exit(status());
  }

  const once = args.includes('--once');
  const period = intervalMs();

  console.log(
    `📡 portal publisher starting (interval ${Math.round(period / 1000)}s, public dir ${publicDir()})`
  );

  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  const tick = async (): Promise<void> => {
    const startedAt = Date.now();
    const result = await runCycle();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

    if (result.ok) {
      console.log(`✅ published in ${elapsed}s — ${describe(result)}`);
    } else {
      // Keep the previous documents; say loudly that they have stopped moving.
      const manifest = markPortalPublishFailure();
      const failures = manifest?.freshness?.consecutiveFailures ?? 0;
      console.error(`❌ cycle ${describe(result)} (consecutive failures: ${failures})`);
    }

    if (once) {
      process.exit(result.ok ? 0 : 1);
    }

    if (!stopping) {
      timer = setTimeout(() => {
        void tick();
      }, period);
    }
  };

  const shutdown = (): void => {
    stopping = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await tick();
}

// Only run as a program; importing this module (tests do) must not start a loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
