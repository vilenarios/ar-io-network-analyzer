/**
 * The only network surface in the capture process.
 *
 * Two read calls exist and nothing else: `getProgramAccounts` for the live
 * Observation accounts, and `getAccountInfo` for the registry slot order
 * (see registry.ts). Nothing here ever signs, writes or logs the endpoint.
 */

import { createSolanaRpc } from '@solana/kit';
import { safeHost } from '../utils/runtime.js';

/** Anchor discriminator for `account:Observation` — sha256 prefix, 8 bytes. */
export const OBSERVATION_DISCRIMINATOR_B64 = 'bb6+Xxys80o=';
/** The same 8 bytes, base58 — the form a memcmp filter wants. */
export const OBSERVATION_DISCRIMINATOR_B58 = 'KMfZcioTTQV';
/** Fixed on-chain size of an Observation account. */
export const OBSERVATION_ACCOUNT_BYTES = 469;

/**
 * The Epoch account: one per epoch, holding the reward economics and the
 * prescription record. sha256('account:Epoch')[0..8) in base58.
 */
export const EPOCH_DISCRIMINATOR_B58 = 'GcP27J5iCGs';

export const EPOCH_ACCOUNT_BYTES = 9408;

/** Retry policy: the SDK defaults (3 attempts / 10s cap) are too tight for a 10-minute cadence. */
export const CAPTURE_RETRY_OPTIONS = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export interface RawObservationAccount {
  pubkey: string;
  data: Buffer;
}

export interface ProgramAccountsResult {
  contextSlot: number;
  accounts: RawObservationAccount[];
}

interface RpcResponse<T> {
  context: { slot: bigint | number };
  value: T;
}

interface EncodedAccount {
  data: [string, string];
  owner: string;
  lamports: bigint | number;
  space?: bigint | number;
}

interface ProgramAccountEntry {
  pubkey: string;
  account: EncodedAccount;
}

/**
 * Structural view of the handful of RPC methods we use.
 *
 * `@solana/kit`'s generated API types are branded (base58/base64 strings,
 * bigint offsets) and do not resolve cleanly under this repo's `node`
 * moduleResolution, so the client is narrowed to exactly what capture calls.
 */
interface SolanaRpcLike {
  getProgramAccounts(
    program: string,
    config: {
      encoding: 'base64';
      withContext: true;
      commitment?: string;
      filters?: ReadonlyArray<
        { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: 'base58' } }
      >;
      dataSlice?: { offset: number; length: number };
    }
  ): { send(): Promise<RpcResponse<ProgramAccountEntry[]>> };

  getAccountInfo(
    address: string,
    config: {
      encoding: 'base64';
      commitment?: string;
      dataSlice?: { offset: number; length: number };
    }
  ): { send(): Promise<RpcResponse<EncodedAccount | null>> };

  getSignaturesForAddress(
    address: string,
    config: { limit: number; before?: string }
  ): { send(): Promise<SignatureEntry[]> };

  getTransaction(
    signature: string,
    config: { maxSupportedTransactionVersion: 0; encoding: 'json' }
  ): { send(): Promise<TransactionEntry | null> };
}

interface SignatureEntry {
  signature: string;
  blockTime: bigint | number | null;
}

interface TransactionEntry {
  transaction: { message: { accountKeys: readonly string[] } };
}

export interface RpcClient {
  /** Host only — never the full URL, which may carry a provider token. */
  readonly host: string;
  readonly programId: string;
  readonly rpc: SolanaRpcLike;
}

/**
 * Build the client. The endpoint is read from the environment here and
 * nowhere else; only its host is ever exposed.
 */
export async function createRpcClient(): Promise<RpcClient> {
  const { MAINNET_RPC_URL, ARIO_GAR_PROGRAM_ID } = await import('@ar.io/sdk');
  const url = process.env.SOLANA_RPC_URL || MAINNET_RPC_URL;

  return {
    host: safeHost(url),
    programId: ARIO_GAR_PROGRAM_ID as unknown as string,
    rpc: createSolanaRpc(url) as unknown as SolanaRpcLike,
  };
}

function toSlot(slot: bigint | number): number {
  return typeof slot === 'bigint' ? Number(slot) : slot;
}

/**
 * One call returns every live Observation account in the network.
 *
 * Both filters are load-bearing: `dataSize` makes a layout change stop
 * matching (loudly, via the canary below) rather than silently mis-decode,
 * and the discriminator memcmp keeps other GAR accounts out.
 */
export async function fetchObservationAccounts(client: RpcClient): Promise<ProgramAccountsResult> {
  const { withRetry } = await import('@ar.io/sdk');

  const response = await withRetry(
    () =>
      client.rpc
        .getProgramAccounts(client.programId, {
          encoding: 'base64',
          withContext: true,
          filters: [
            { dataSize: BigInt(OBSERVATION_ACCOUNT_BYTES) },
            {
              memcmp: {
                offset: 0n,
                bytes: OBSERVATION_DISCRIMINATOR_B58,
                encoding: 'base58',
              },
            },
          ],
        })
        .send(),
    CAPTURE_RETRY_OPTIONS
  );

  return {
    contextSlot: toSlot(response.context.slot),
    accounts: response.value.map((entry) => ({
      pubkey: entry.pubkey,
      data: Buffer.from(entry.account.data[0], 'base64'),
    })),
  };
}

/**
 * One call returns every live Epoch account.
 *
 * Same two-filter contract as the observation fetch — `dataSize` turns a
 * layout change into a visible zero-result rather than a silent mis-decode.
 *
 * Unlike observations, Epoch accounts are reclaimed by a permissionless
 * `close_epoch`, so whatever is on chain at poll time is all that will ever
 * be available. This capture is the durable record.
 */
export async function fetchEpochAccounts(client: RpcClient): Promise<ProgramAccountsResult> {
  const { withRetry } = await import('@ar.io/sdk');

  const response = await withRetry(
    () =>
      client.rpc
        .getProgramAccounts(client.programId, {
          encoding: 'base64',
          withContext: true,
          filters: [
            { dataSize: BigInt(EPOCH_ACCOUNT_BYTES) },
            {
              memcmp: {
                offset: 0n,
                bytes: EPOCH_DISCRIMINATOR_B58,
                encoding: 'base58',
              },
            },
          ],
        })
        .send(),
    CAPTURE_RETRY_OPTIONS
  );

  return {
    contextSlot: toSlot(response.context.slot),
    accounts: response.value.map((entry) => ({
      pubkey: entry.pubkey,
      data: Buffer.from(entry.account.data[0], 'base64'),
    })),
  };
}

/**
 * Hourly canary: count accounts by discriminator alone, with no size filter.
 *
 * `canaryCount > accountCount` means the account layout changed size and the
 * primary query has started silently missing rows.
 */
export async function fetchDiscriminatorOnlyCount(client: RpcClient): Promise<number> {
  const { withRetry } = await import('@ar.io/sdk');

  const response = await withRetry(
    () =>
      client.rpc
        .getProgramAccounts(client.programId, {
          encoding: 'base64',
          withContext: true,
          dataSlice: { offset: 0, length: 0 },
          filters: [
            {
              memcmp: {
                offset: 0n,
                bytes: OBSERVATION_DISCRIMINATOR_B58,
                encoding: 'base58',
              },
            },
          ],
        })
        .send(),
    CAPTURE_RETRY_OPTIONS
  );

  return response.value.length;
}

/** Raw account fetch used by the registry snapshot. */
export async function fetchAccount(client: RpcClient, address: string) {
  const { withRetry } = await import('@ar.io/sdk');

  const response = await withRetry(
    () => client.rpc.getAccountInfo(address, { encoding: 'base64' }).send(),
    CAPTURE_RETRY_OPTIONS
  );

  return {
    contextSlot: toSlot(response.context.slot),
    data: response.value ? Buffer.from(response.value.data[0], 'base64') : null,
  };
}

/** The creating transaction for an account, as recovered from its signature history. */
export interface AccountCreation {
  creator: string;
  createdAt: number;
}

/**
 * Recover who paid to create an account, from the OLDEST signature on it.
 *
 * The fee payer of an account's first transaction is the wallet that funded
 * its rent. This is only correct while the full history is inside the RPC
 * node's retention window -- if the oldest page is truncated we would read
 * some later transaction as the creation and attribute it to the wrong
 * wallet, so bail out rather than record a plausible-looking lie.
 *
 * Called once per epoch (creation never changes), not once per cycle.
 */
export async function fetchAccountCreation(
  client: RpcClient,
  address: string
): Promise<AccountCreation | null> {
  const { withRetry } = await import('@ar.io/sdk');
  const PAGE = 1000;
  const MAX_PAGES = 10;

  let before: string | undefined;
  let oldest: SignatureEntry | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await withRetry(
      () =>
        client.rpc
          .getSignaturesForAddress(address, {
            limit: PAGE,
            ...(before !== undefined ? { before } : {}),
          })
          .send(),
      CAPTURE_RETRY_OPTIONS
    );
    if (batch.length === 0) break;
    oldest = batch[batch.length - 1];
    if (batch.length < PAGE) {
      before = undefined;
      break;
    }
    before = oldest!.signature;
    // Still a full page on the last allowed iteration: history is deeper than
    // we are willing to walk, so we cannot know which tx was the creation.
    if (page === MAX_PAGES - 1) return null;
  }

  if (!oldest) return null;

  const tx = await withRetry(
    () =>
      client.rpc
        .getTransaction(oldest!.signature, {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send(),
    CAPTURE_RETRY_OPTIONS
  );
  if (!tx) return null;

  const keys = tx.transaction.message.accountKeys;
  const creator = keys?.[0];
  const blockTime = oldest.blockTime;
  if (typeof creator !== 'string' || blockTime === null || blockTime === undefined) {
    return null;
  }

  return { creator, createdAt: Number(blockTime) };
}
