/**
 * JSON-RPC access to the ARIO program's transaction logs.
 *
 * Only log messages are needed — the reward events are Anchor `Program data:`
 * lines — so this deliberately does not decode instructions or balances.
 */

import { ARIO_PROGRAM_ID, type ScanTransaction } from './scan.js';

const MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

export interface ProgramReader {
  listSignatures: (sinceSeconds: number) => Promise<ScanTransaction[]>;
  logsFor: (signature: string) => Promise<{
    logMessages: readonly string[];
    accountKeys: readonly string[];
  } | null>;
  rpcCalls: () => number;
}

export function createProgramReader(
  url = process.env.SOLANA_RPC_URL || MAINNET_RPC_URL
): ProgramReader {
  let calls = 0;
  const logs = new Map<
    string,
    { logMessages: readonly string[]; accountKeys: readonly string[] } | null
  >();

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

  return {
    async listSignatures(sinceSeconds) {
      const all: ScanTransaction[] = [];
      let before: string | undefined;

      // Paged newest-first; stop as soon as a page ends older than we need
      // rather than walking to genesis every run.
      for (;;) {
        const page = await rpc<ScanTransaction[]>('getSignaturesForAddress', [
          ARIO_PROGRAM_ID,
          before ? { limit: 1000, before } : { limit: 1000 },
        ]);
        if (page.length === 0) break;
        all.push(...page);

        const oldest = page[page.length - 1];
        before = oldest.signature;
        if (page.length < 1000) break;
        if (oldest.blockTime !== null && Number(oldest.blockTime) < sinceSeconds) break;
      }
      return all;
    },

    async logsFor(signature) {
      if (logs.has(signature)) return logs.get(signature) ?? null;
      const tx = await rpc<{
        meta?: { logMessages?: string[]; err?: unknown } | null;
        transaction?: { message?: { accountKeys?: string[] } };
      }>('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]);
      // `json` encoding gives accountKeys as plain strings in order, index 0
      // being the fee payer and signer — which is what attribution checks.
      const result =
        tx?.meta && !tx.meta.err
          ? {
              logMessages: tx.meta.logMessages ?? [],
              accountKeys: tx.transaction?.message?.accountKeys ?? [],
            }
          : null;
      logs.set(signature, result);
      return result;
    },

    rpcCalls: () => calls,
  };
}
