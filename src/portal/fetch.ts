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
import { fetchPrimaryNames, type DiscriminatorScanner, type PrimaryNameScan } from './primary-names.js';
import { resolvePortalNetwork, type PortalNetwork, type PortalProgramIds } from './contract.js';

/** One call per document; the SDK paginates in memory, so this is one sweep each. */
const FULL_SCAN = { limit: Number.MAX_SAFE_INTEGER } as const;

export interface PortalSnapshot {
  network: PortalNetwork;
  /** Host only — never the endpoint, which may carry a token. */
  host: string;
  /** The programs these accounts were read from. Public constants, not secrets. */
  programIds: PortalProgramIds;
  gateways: unknown[];
  vaults: unknown[];
  balances: unknown[];
  delegates: unknown[];
  /**
   * Every `Withdrawal` account in the GAR program. Serves the portal's
   * per-gateway vault view by filtering on `gatewayAddress`.
   *
   * It does NOT serve `getWithdrawals(address)`: both public SDK projections
   * drop the `owner` field, and the raw decoder that keeps it is reachable
   * only through a private method. A per-wallet withdrawal lookup is a
   * memcmp-filtered read anyway — the cheap class this service does not need
   * to displace.
   */
  withdrawals: unknown[];
  primaryNames: unknown[];
  /**
   * How the primary-name join went. Carried so a join that silently
   * stops matching surfaces as a number rather than as a document that
   * quietly got smaller — see ./primary-names.ts.
   */
  primaryNameScan: PrimaryNameScan;
  arnsRecords: unknown[];
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
 * Reads run sequentially rather than with `Promise.all`. Concurrent
 * whole-program scans are exactly the burst an endpoint rate-limits, and the
 * whole set completes in under a second anyway — there is nothing to win and a
 * 429 to lose.
 *
 * Order is load-bearing in one place: the ArNS sweep must precede the primary
 * names, which are joined against it instead of re-read per name.
 */
export async function fetchPortalSnapshot(): Promise<PortalSnapshot> {
  const { ario, host, programIds } = await initSolanaArio();

  // An operator can state the network explicitly; otherwise it is inferred
  // from the host, which for most providers encodes it. Neither working is a
  // hard failure rather than a `network: "unknown"` document that every
  // consumer would silently refuse — see resolvePortalNetwork.
  const network = resolvePortalNetwork(host);

  const gateways = items((await ario.getGateways(FULL_SCAN)) as Paged);
  const vaults = items((await ario.getVaults(FULL_SCAN)) as Paged);
  const balances = items((await ario.getBalances(FULL_SCAN)) as Paged);
  const delegates = items((await ario.getAllDelegates(FULL_SCAN)) as Paged);
  const withdrawals = items((await ario.getAllGatewayVaults(FULL_SCAN)) as Paged);

  // Ask for every record rather than `{ limit: 1 }`. It costs the same: the
  // SDK scans the whole ArNS program and deserializes every account before
  // `paginate()` truncates in memory, so a limit narrows the reply and not
  // the query. Taking the items keeps the work instead of discarding it.
  const arnsRecords = items((await ario.getArNSRecords(FULL_SCAN)) as Paged);
  const arnsRecordCount = arnsRecords.length;

  // Not `ario.getPrimaryNames()`: that attaches `processId` with one
  // `getAccountInfo` per name, which measured as ~81% of this service's RPC
  // bill. The sweep above already carries every `processId`, so the join is
  // local and the scan costs what it always did.
  const primaryNameScan = await fetchPrimaryNames(
    ario as unknown as DiscriminatorScanner,
    arnsRecords,
  );
  const primaryNames = primaryNameScan.items;

  const tokenSupply = await ario.getTokenSupply();
  const demandFactor = await readDemandFactor(ario);
  const gatewayRegistrySettings = await ario.getGatewayRegistrySettings();

  return {
    network,
    host,
    programIds,
    gateways,
    vaults,
    balances,
    delegates,
    withdrawals,
    primaryNames,
    primaryNameScan,
    arnsRecords,
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
