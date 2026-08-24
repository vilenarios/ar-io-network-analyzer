/**
 * The only network surface in the portal publisher.
 *
 * Five reads per cycle, each a whole-program scan the SDK paginates in memory.
 * That is the entire point of this service: these scans happen here, on a
 * cadence, instead of in every visitor's browser.
 *
 * The endpoint is obtained through `initSolanaArio()` so that
 * `SOLANA_RPC_URL` keeps being read in exactly the two places this repo
 * documents. It may carry a provider token, so only `safeHost()` output ever
 * leaves this module.
 */

import { initSolanaArio } from '../data/gateway-fetcher.js';
import { inferNetwork, type PortalNetwork } from './contract.js';

/** One call per document; the SDK paginates in memory, so this is one sweep each. */
const FULL_SCAN = { limit: Number.MAX_SAFE_INTEGER } as const;

export interface PortalSnapshot {
  network: PortalNetwork;
  /** Host only — never the endpoint, which may carry a token. */
  host: string;
  gateways: unknown[];
  vaults: unknown[];
  balances: unknown[];
  delegates: unknown[];
  arnsRecordCount: number;
  tokenSupply: unknown;
  demandFactor: number | null;
  gatewayRegistrySettings: unknown;
}

interface Paged {
  items?: unknown[];
  totalItems?: number;
}

function items(result: Paged | undefined): unknown[] {
  return Array.isArray(result?.items) ? result.items : [];
}

/**
 * Fetch everything the portal would otherwise scan for itself.
 *
 * Reads run sequentially rather than with `Promise.all`. Five concurrent
 * whole-program scans is exactly the burst an endpoint rate-limits, and the
 * whole set completes in under a second anyway — there is nothing to win and a
 * 429 to lose.
 */
export async function fetchPortalSnapshot(): Promise<PortalSnapshot> {
  const { ario, host } = await initSolanaArio();

  // An operator can state the network explicitly; otherwise it is inferred
  // from the host, which for most providers encodes it.
  const network = inferNetwork(process.env.PORTAL_NETWORK || host);

  const gateways = items((await ario.getGateways(FULL_SCAN)) as Paged);
  const vaults = items((await ario.getVaults(FULL_SCAN)) as Paged);
  const balances = items((await ario.getBalances(FULL_SCAN)) as Paged);
  const delegates = items((await ario.getAllDelegates(FULL_SCAN)) as Paged);

  // The portal reads only `totalItems` from this, so ask for one record rather
  // than publishing ~3,000 of them for a count.
  const arnsPage = (await ario.getArNSRecords({ limit: 1 })) as Paged;
  const arnsRecordCount = arnsPage?.totalItems ?? 0;

  const tokenSupply = await ario.getTokenSupply();
  const demandFactor = await readDemandFactor(ario);
  const gatewayRegistrySettings = await ario.getGatewayRegistrySettings();

  return {
    network,
    host,
    gateways,
    vaults,
    balances,
    delegates,
    arnsRecordCount,
    tokenSupply,
    demandFactor,
    gatewayRegistrySettings,
  };
}

/**
 * The demand factor is the one scalar that is not load-bearing for any table,
 * so a failure here degrades the document rather than failing the cycle.
 */
async function readDemandFactor(ario: { getDemandFactor(): Promise<unknown> }): Promise<
  number | null
> {
  try {
    const value = await ario.getDemandFactor();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
