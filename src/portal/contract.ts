/**
 * The portal snapshot contract (v1).
 *
 * These documents exist for one reason: every browser that loads the network
 * portal was independently running `getProgramAccounts` over whole Solana
 * programs, so RPC cost scaled with popularity. One publisher now runs those
 * scans on a fixed cadence and every visitor reads static JSON.
 *
 * Design rules, each of which cost something to learn:
 *
 * 1. **Documents carry the SDK's decoded shape verbatim, not a projection.**
 *    All five together are ~258 KB gzipped, so trimming buys little and costs
 *    a contract that silently breaks whenever the portal renders a field the
 *    projection dropped.
 * 2. **A snapshot is never authoritative.** Every document is re-derivable
 *    from chain at any time, unlike the observation capture in this repo,
 *    which is irreplaceable. Nothing here is a durable record and no database
 *    is involved — a lost snapshot costs one cycle.
 * 3. **`generatedAt` is load-bearing.** Consumers are expected to fall back to
 *    direct RPC when a document is older than they can tolerate. Publishing a
 *    stale document is normal; hiding its age is not.
 *
 * This is a separate namespace from the observer documents (`/api/v1/*.json`)
 * with its own manifest and version, so the two contracts can move
 * independently.
 */

import type { DocumentEntry } from '../publish/contract.js';

export const PORTAL_SCHEMA_VERSION = '1.0';

/** Every portal document lives under this prefix. */
export const PORTAL_PREFIX = 'api/v1/portal';

/** Document names, in the order the publisher writes them. */
export const PORTAL_DOCUMENTS = [
  'gateways',
  'vaults',
  'balances',
  'delegates',
  'summary',
] as const;

export type PortalDocumentName = (typeof PORTAL_DOCUMENTS)[number];

/**
 * The manifest a consumer polls.
 *
 * Deliberately small and separately cacheable: the portal fetches this to
 * decide whether its cached documents are still current, so it is the one
 * document requested on a short interval.
 */
export interface PortalManifest {
  schemaVersion: string;
  generatedAt: string;
  /** Inferred from the RPC endpoint host. Never the endpoint itself. */
  network: PortalNetwork;
  documents: Partial<Record<PortalDocumentName, DocumentEntry>>;
  freshness: {
    generatedAt: string;
    ageSeconds: number;
    /** True when the last publish cycle failed and these documents are carried over. */
    stale: boolean;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
  };
}

export type PortalNetwork = 'mainnet' | 'devnet' | 'testnet' | 'localnet' | 'unknown';

/**
 * Common envelope. `count` is the item count and is always the length of
 * `items` — a consumer that reads one and paginates on the other cannot drift.
 */
export interface PortalCollectionDocument<T> {
  schemaVersion: string;
  generatedAt: string;
  network: PortalNetwork;
  count: number;
  items: T[];
}

/**
 * Scalars the portal would otherwise fetch one RPC call at a time on every
 * page load. Small enough that it costs nothing to publish together.
 *
 * `arnsRecordCount` is a count only. The portal reads `totalItems` from a
 * `getArNSRecords({ limit: 1 })` call, so publishing all ~3,000 records would
 * add ~160 KB for a number.
 */
export interface PortalSummaryDocument {
  schemaVersion: string;
  generatedAt: string;
  network: PortalNetwork;
  counts: {
    gateways: number;
    vaults: number;
    balances: number;
    delegates: number;
    arnsRecords: number;
  };
  tokenSupply: unknown;
  demandFactor: number | null;
  gatewayRegistrySettings: unknown;
}

/**
 * Infer the network from an RPC URL without ever exposing the URL.
 *
 * The endpoint may carry a provider token in its path, so only the decision is
 * kept — never the input. Mirrors the portal's own inference so a document and
 * the app agree on which network they are talking about.
 */
export function inferNetwork(rpcUrl: string): PortalNetwork {
  const probe = (value: string): PortalNetwork => {
    const lower = value.toLowerCase();
    if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'localnet';
    if (lower.includes('devnet')) return 'devnet';
    if (lower.includes('testnet')) return 'testnet';
    if (lower.includes('mainnet')) return 'mainnet';
    return 'unknown';
  };

  try {
    const url = new URL(rpcUrl);
    return probe(`${url.hostname}${url.pathname}`);
  } catch {
    return probe(rpcUrl);
  }
}

/** `api/v1/portal/<name>.json` — the path a document is published at. */
export function portalDocumentPath(name: PortalDocumentName | 'index'): string {
  return `${PORTAL_PREFIX}/${name}.json`;
}
