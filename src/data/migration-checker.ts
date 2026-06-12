/**
 * Solana Migration Checker
 *
 * Looks up AR-IO-Solana-Registration attestations on Arweave via Goldsky GraphQL
 * to determine which gateway operators have completed the Solana migration.
 *
 * Mirrors the registration app's lookup logic (solana-ar-io/migration/solana-registration-app/
 * src/services/arweave-graphql.ts) but batches `owners` queries for efficiency since
 * we check hundreds of wallets per run.
 *
 * Migrations are permanent — results are cached to disk so re-runs only query
 * for wallets we haven't seen migrated yet.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const GOLDSKY_URL = 'https://arweave-search.goldsky.com/graphql';
const ATTESTATION_APP_NAME = 'AR-IO-Solana-Registration';
const QUERY_TIMEOUT_MS = 20_000;
const BATCH_SIZE = 50; // Number of wallets per GraphQL request
const CACHE_PATH = 'reports/migration-cache.json';

export interface MigrationResult {
  wallet: string;
  migrated: boolean;
  txId?: string;
  solanaPubkey?: string;
  timestamp?: number;
}

interface GqlEdge {
  node: {
    id: string;
    owner: { address: string };
    tags: { name: string; value: string }[];
  };
}

interface CacheFile {
  version: 1;
  updated: string;
  results: Record<string, Omit<MigrationResult, 'wallet'>>;
}

function loadCache(): Map<string, Omit<MigrationResult, 'wallet'>> {
  if (!existsSync(CACHE_PATH)) return new Map();
  try {
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw) as CacheFile;
    return new Map(Object.entries(data.results || {}));
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, Omit<MigrationResult, 'wallet'>>): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file: CacheFile = {
    version: 1,
    updated: new Date().toISOString(),
    results: Object.fromEntries(cache.entries()),
  };
  writeFileSync(CACHE_PATH, JSON.stringify(file, null, 2));
}

function getTagValue(tags: { name: string; value: string }[], name: string): string | undefined {
  return tags.find((t) => t.name === name)?.value;
}

const QUERY = `
query($owners: [String!]!, $cursor: String) {
  transactions(
    owners: $owners
    tags: [
      { name: "Version", values: ["1"] }
      { name: "Action", values: ["Register"] }
    ]
    sort: HEIGHT_DESC
    first: 100
    after: $cursor
  ) {
    pageInfo { hasNextPage }
    edges {
      cursor
      node {
        id
        owner { address }
        tags { name value }
      }
    }
  }
}`;

async function queryBatch(owners: string[]): Promise<Map<string, Omit<MigrationResult, 'wallet'>>> {
  const found = new Map<string, Omit<MigrationResult, 'wallet'>>();
  let cursor: string | null = null;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(GOLDSKY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { owners, cursor } }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`Goldsky responded ${res.status}`);
    }

    const json = (await res.json()) as {
      data?: {
        transactions?: {
          pageInfo?: { hasNextPage: boolean };
          edges?: Array<GqlEdge & { cursor: string }>;
        };
      };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(`Goldsky GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }

    const edges = json.data?.transactions?.edges ?? [];
    for (const edge of edges) {
      const ownerAddr = edge.node.owner.address;
      // Skip if we already recorded a migration for this owner — sort is HEIGHT_DESC so
      // the first match per owner is the latest.
      if (found.has(ownerAddr)) continue;

      const appName = getTagValue(edge.node.tags, 'App-Name');
      if (appName !== ATTESTATION_APP_NAME) continue;

      const sourceAddress = getTagValue(edge.node.tags, 'Source-Address');
      const solanaPubkey = getTagValue(edge.node.tags, 'Solana-Pubkey');
      const sourceChain = getTagValue(edge.node.tags, 'Source-Chain');
      if (!sourceAddress || !solanaPubkey || !sourceChain) continue;

      const tagTimestamp = getTagValue(edge.node.tags, 'Timestamp');
      const timestamp = tagTimestamp ? Math.floor(Number(tagTimestamp) / 1000) : 0;

      found.set(ownerAddr, {
        migrated: true,
        txId: edge.node.id,
        solanaPubkey,
        timestamp,
      });
    }

    const nextCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    if (!json.data?.transactions?.pageInfo?.hasNextPage || !nextCursor) break;
    cursor = nextCursor;
  }

  return found;
}

/**
 * Check Solana migration status for a list of Arweave wallet addresses.
 * Uses on-disk cache to avoid re-querying wallets already known to have migrated.
 */
export async function checkMigrationStatus(wallets: string[]): Promise<Map<string, MigrationResult>> {
  const cache = loadCache();
  const results = new Map<string, MigrationResult>();

  // Wallets known migrated from cache — skip network entirely
  const toQuery: string[] = [];
  for (const wallet of wallets) {
    const cached = cache.get(wallet);
    if (cached?.migrated) {
      results.set(wallet, { wallet, ...cached });
    } else {
      toQuery.push(wallet);
    }
  }

  if (toQuery.length === 0) {
    return results;
  }

  // Batch the rest
  const batches = Math.ceil(toQuery.length / BATCH_SIZE);
  for (let i = 0; i < batches; i++) {
    const batch = toQuery.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    process.stdout.write(`\r   [${Math.min((i + 1) * BATCH_SIZE, toQuery.length)}/${toQuery.length}] Querying Goldsky...`);

    let migrations: Map<string, Omit<MigrationResult, 'wallet'>>;
    try {
      migrations = await queryBatch(batch);
    } catch (err) {
      console.warn(`\n   ⚠️  Batch ${i + 1}/${batches} failed: ${err instanceof Error ? err.message : err}`);
      // Mark these as "not migrated" for this run but don't cache the negative result —
      // a transient failure shouldn't poison the cache.
      for (const wallet of batch) {
        if (!results.has(wallet)) results.set(wallet, { wallet, migrated: false });
      }
      continue;
    }

    for (const wallet of batch) {
      const m = migrations.get(wallet);
      if (m) {
        const entry = { migrated: true, txId: m.txId, solanaPubkey: m.solanaPubkey, timestamp: m.timestamp };
        cache.set(wallet, entry);
        results.set(wallet, { wallet, ...entry });
      } else {
        results.set(wallet, { wallet, migrated: false });
      }
    }
  }
  process.stdout.write('\n');

  saveCache(cache);
  return results;
}
