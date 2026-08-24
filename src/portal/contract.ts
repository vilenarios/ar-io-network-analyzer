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
 *    All eight together are ~494 KB gzipped (mainnet, 2026-08-24), so trimming
 *    buys little and costs a contract that silently breaks whenever the portal
 *    renders a field the projection dropped.
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

// 1.2 adds `programIds` to the manifest and to every document envelope.
// 1.1 added `withdrawals`, `primaryNames` and `arnsRecords`. Additive only:
// every earlier document keeps its path and shape, and consumers discover
// documents from the manifest, so an older reader is unaffected.
export const PORTAL_SCHEMA_VERSION = '1.2';

/** Every portal document lives under this prefix. */
export const PORTAL_PREFIX = 'api/v1/portal';

/** Document names, in the order the publisher writes them. */
export const PORTAL_DOCUMENTS = [
  'gateways',
  'vaults',
  'balances',
  'delegates',
  'withdrawals',
  'primaryNames',
  'arnsRecords',
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
  /** The programs every document in this manifest was derived from. */
  programIds: PortalProgramIds;
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
 * The Solana programs a document was derived from.
 *
 * Carried on the manifest AND on every document, because `network` alone is
 * not enough to know what you are reading. Program ids are per-cluster, the
 * SDK requires explicit overrides off mainnet, and a redeploy moves them. A
 * consumer that decodes accounts from the wrong program does not get an
 * error — it gets plausible nonsense. Stamping the ids makes a document
 * self-describing and lets a consumer refuse a mismatch outright.
 */
export interface PortalProgramIds {
  core: string;
  gar: string;
  arns: string;
  ant: string;
}

/**
 * Common envelope. `count` is the item count and is always the length of
 * `items` — a consumer that reads one and paginates on the other cannot drift.
 */
export interface PortalCollectionDocument<T> {
  schemaVersion: string;
  generatedAt: string;
  network: PortalNetwork;
  /** Repeated per document, not only in the manifest: documents are fetched
   *  individually and are often cached or copied away from it. */
  programIds: PortalProgramIds;
  count: number;
  items: T[];
}

/**
 * Scalars the portal would otherwise fetch one RPC call at a time on every
 * page load. Small enough that it costs nothing to publish together.
 *
 * `counts.arnsRecords` stays here even though `arnsRecords.json` now exists:
 * the portal's `useArNSStats` wants only `totalItems`, and reading a number
 * out of a 1 KB summary beats pulling a 160 KB document to call `.length` on
 * it. The full records are published for consumers that list or search names.
 */
export interface PortalSummaryDocument {
  schemaVersion: string;
  generatedAt: string;
  network: PortalNetwork;
  programIds: PortalProgramIds;
  counts: {
    gateways: number;
    vaults: number;
    balances: number;
    delegates: number;
    withdrawals: number;
    primaryNames: number;
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

/**
 * Decide which cluster this publisher is serving, refusing to guess.
 *
 * `inferNetwork` returns `'unknown'` for any endpoint whose host does not
 * literally contain a cluster name — an internal resolver, a vanity domain, or
 * a provider with domain masking enabled. Publishing `network: "unknown"` is
 * far worse than failing: the portal compares the field against its own
 * inference, which falls back to **`'mainnet'`**, so every document would be
 * silently refused. The publisher would keep succeeding, `/healthz` would stay
 * green, the freshness alert would never fire, and the service would degrade
 * into an expensive no-op that consumers ignore — with no signal anywhere.
 *
 * So an unresolvable cluster is a hard startup failure with an actionable
 * message, which the freshness alerting *does* surface.
 *
 * @throws when `PORTAL_NETWORK` is set to something unrecognised, or is unset
 *   and the endpoint does not identify its cluster.
 */
export function resolvePortalNetwork(fallbackSource: string): PortalNetwork {
  const explicit = (process.env.PORTAL_NETWORK ?? '').trim();

  if (explicit) {
    const named = inferNetwork(explicit);
    if (named === 'unknown') {
      throw new Error(
        `PORTAL_NETWORK="${explicit}" is not a network this publisher recognises. ` +
          `Expected one of: mainnet, devnet, testnet, localnet.`
      );
    }
    return named;
  }

  const inferred = inferNetwork(fallbackSource);
  if (inferred === 'unknown') {
    throw new Error(
      'Cannot tell which Solana cluster this endpoint serves, and PORTAL_NETWORK is not set. ' +
        'Publishing network:"unknown" would be silently rejected by every consumer that checks ' +
        'the field — the network portal compares it against its own inference, which falls back ' +
        'to "mainnet" — so the snapshot would be refused while this publisher kept reporting ' +
        'success. Set PORTAL_NETWORK explicitly in the instance env file.'
    );
  }
  return inferred;
}

/** `api/v1/portal/<name>.json` — the path a document is published at. */
export function portalDocumentPath(name: PortalDocumentName | 'index'): string {
  return `${PORTAL_PREFIX}/${name}.json`;
}
