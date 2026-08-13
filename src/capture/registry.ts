/**
 * Registry slot-order snapshots.
 *
 * Bit `i` of an observation's `gateway_results` refers to registry slot `i`,
 * and slot order mutates as gateways join and leave. Observation accounts are
 * deleted from the chain within days, so a snapshot that is not taken while
 * the epoch is live can never be reconstructed — the bitmaps would be
 * permanently undecodable. This is the one thing capture does besides capture.
 *
 * GatewayRegistry layout:
 *   0   discriminator (8)
 *   8   authority pubkey (32)
 *   40  count u32
 *   44  padding (4)
 *   48  gateways: 3000 x GatewaySlot (56 bytes each, address first)
 */

import { createHash } from 'crypto';
import { getAddressDecoder } from '@solana/kit';
import type { RegistrySnapshot } from '../observers/types.js';
import { fetchAccount, type RpcClient } from './rpc.js';

const COUNT_OFFSET = 40;
const SLOTS_OFFSET = 48;
const SLOT_BYTES = 56;
const MAX_SLOTS = 3000;

const addressDecoder = getAddressDecoder();

/**
 * Fetch the current registry slot order and label it with the epoch it was
 * captured during. One `getAccountInfo` per newly seen epoch (~1/day).
 */
export async function fetchRegistrySlotOrder(
  client: RpcClient,
  epochIndex: number
): Promise<RegistrySnapshot> {
  const { getGatewayRegistryPDA } = await import('@ar.io/sdk');
  const [registryPubkey] = await getGatewayRegistryPDA();

  const { contextSlot, data } = await fetchAccount(client, registryPubkey as unknown as string);
  if (!data) {
    throw new Error('gateway registry account not found');
  }
  if (data.length < SLOTS_OFFSET) {
    throw new Error(`gateway registry account too small: ${data.length} bytes`);
  }

  const gatewayCount = data.readUInt32LE(COUNT_OFFSET);
  if (gatewayCount > MAX_SLOTS) {
    throw new Error(`gateway registry count out of range: ${gatewayCount}`);
  }

  const slots: string[] = [];
  for (let i = 0; i < gatewayCount; i++) {
    const start = SLOTS_OFFSET + i * SLOT_BYTES;
    if (start + 32 > data.length) {
      throw new Error(`gateway registry truncated at slot ${i}`);
    }
    slots.push(addressDecoder.decode(data.subarray(start, start + 32)) as unknown as string);
  }

  return {
    epochIndex,
    gatewayCount,
    capturedAt: Date.now(),
    capturedAtSlot: contextSlot,
    registryPubkey: registryPubkey as unknown as string,
    digest: createHash('sha256').update(slots.join('')).digest('hex'),
    slots,
  };
}
