/**
 * Minimal JSON-RPC reader for the protocol's ARIO token account.
 *
 * Deliberately not the SDK: this needs transaction metadata
 * (`postTokenBalances`), which the SDK does not expose, and it is shared by the
 * live sampler and the one-shot recovery so that both anchor rows the same way.
 */

import { recoverBoundaryBalance, usableSignatures, type SignatureRef } from './boundary.js';

export const MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

/**
 * The protocol's ARIO token account.
 *
 * A hardcoded address is a liability, so callers writing history must verify it
 * with `assertMatchesLiveBalance` first: a wrong address yields a complete,
 * plausible, entirely fictional series rather than an error.
 */
export const PROTOCOL_TOKEN_ACCOUNT =
  process.env.ARIO_PROTOCOL_TOKEN_ACCOUNT || '6Sj3DQAynK916KfBHUZxnG4aDKdqFpBVPCNdD4X6Vrj5';

interface ParsedTx {
  meta?: {
    err?: unknown;
    postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: { amount?: string } }>;
  } | null;
  transaction?: { message?: { accountKeys?: Array<{ pubkey?: string } | string> } };
}

export interface BalanceReader {
  listSignatures(): Promise<SignatureRef[]>;
  balanceAfter(signature: string): Promise<number | null>;
  currentBalance(): Promise<number | null>;
  /** Balance at an epoch boundary, unix seconds. Null when unrecoverable. */
  balanceAtBoundary(endSeconds: number): Promise<{ balance: number; slot: number } | null>;
  rpcCalls(): number;
}

export function createBalanceReader(url = process.env.SOLANA_RPC_URL || MAINNET_RPC_URL): BalanceReader {
  let calls = 0;
  let cachedSignatures: SignatureRef[] | null = null;
  const balances = new Map<string, number | null>();

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    calls++;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  function keyAt(tx: ParsedTx, index: number): string | undefined {
    const key = tx.transaction?.message?.accountKeys?.[index];
    return typeof key === 'string' ? key : key?.pubkey;
  }

  const reader: BalanceReader = {
    async listSignatures() {
      if (cachedSignatures) return cachedSignatures;
      const all: SignatureRef[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await rpc<SignatureRef[]>('getSignaturesForAddress', [
          PROTOCOL_TOKEN_ACCOUNT,
          before ? { limit: 1000, before } : { limit: 1000 },
        ]);
        if (page.length === 0) break;
        all.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < 1000) break;
      }
      cachedSignatures = all;
      return all;
    },

    async balanceAfter(signature) {
      if (balances.has(signature)) return balances.get(signature) ?? null;

      const tx = await rpc<ParsedTx | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);

      let result: number | null = null;
      if (tx?.meta && !tx.meta.err) {
        for (const entry of tx.meta.postTokenBalances ?? []) {
          if (keyAt(tx, entry.accountIndex) !== PROTOCOL_TOKEN_ACCOUNT) continue;
          const amount = Number(entry.uiTokenAmount?.amount);
          if (Number.isFinite(amount)) {
            result = amount;
            break;
          }
        }
      }
      balances.set(signature, result);
      return result;
    },

    async currentBalance() {
      const result = await rpc<{ value?: { amount?: string } }>('getTokenAccountBalance', [
        PROTOCOL_TOKEN_ACCOUNT,
      ]);
      const amount = Number(result?.value?.amount);
      return Number.isFinite(amount) ? amount : null;
    },

    async balanceAtBoundary(endSeconds) {
      const signatures = usableSignatures(await reader.listSignatures());
      const recovered = await recoverBoundaryBalance(signatures, endSeconds, (signature) =>
        reader.balanceAfter(signature)
      );
      return recovered.balance === null || recovered.slot === null
        ? null
        : { balance: recovered.balance, slot: recovered.slot };
    },

    rpcCalls: () => calls,
  };

  return reader;
}

/**
 * Refuse to proceed unless the hardcoded account agrees with what the live
 * pipeline independently measures. Exact equality, not a tolerance: both sides
 * are integer mARIO read from the same chain, and "close enough" is how a wrong
 * account passes a check.
 */
export async function assertMatchesLiveBalance(
  reader: BalanceReader,
  liveProtocolBalance: number
): Promise<number> {
  const amount = await reader.currentBalance();
  if (amount === null) {
    throw new Error(`${PROTOCOL_TOKEN_ACCOUNT} is not a readable token account`);
  }
  if (amount !== liveProtocolBalance) {
    throw new Error(
      `token account mismatch: ${PROTOCOL_TOKEN_ACCOUNT} holds ${amount} mARIO but the live ` +
        `summary reports protocolBalance ${liveProtocolBalance}. These must be the same ` +
        `account, so either the address is wrong or the summary is not what it claims.`
    );
  }
  return amount;
}
