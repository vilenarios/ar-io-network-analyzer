/**
 * Observation account decoding, plus the startup canaries that make a chain
 * layout change fail loudly instead of quietly producing garbage.
 *
 * Account layout (469 bytes, Anchor/Borsh):
 *   0    discriminator (8)
 *   8    epochIndex u64
 *   16   observer pubkey (32)
 *   48   gatewayResults (375)
 *   423  gatewayCount u16
 *   425  reportTxId (32)
 *   457  submittedAt i64
 *   465  bump u8
 *   466  version { major u8, minor u8, patch u8 }
 */

import { createHash } from 'crypto';
import type { DecodedObservation } from '../observers/types.js';
import {
  OBSERVATION_ACCOUNT_BYTES,
  OBSERVATION_DISCRIMINATOR_B64,
  type RawObservationAccount,
} from './rpc.js';

const GATEWAY_RESULTS_OFFSET = 48;
const GATEWAY_RESULTS_BYTES = 375;
const SCHEMA_MAJOR_OFFSET = 466;

/** A u16 gatewayCount can address at most this many bits of the blob. */
export const MAX_GATEWAY_COUNT = GATEWAY_RESULTS_BYTES * 8; // 3000

/** One day of slack for a chain clock that runs ahead of ours. */
const FUTURE_TIMESTAMP_TOLERANCE_SECONDS = 86400;

export type DecodeOutcome =
  | { ok: true; record: DecodedObservation }
  | { ok: false; reason: string };

/**
 * Decode one account.
 *
 * Never throws: a failure is a value, and the caller parks the raw bytes in
 * `raw_unparsed` rather than dropping them.
 */
export function decodeObservationAccount(account: RawObservationAccount): DecodeOutcome {
  const { data, pubkey } = account;

  if (data.length !== OBSERVATION_ACCOUNT_BYTES) {
    return { ok: false, reason: `unexpected_account_size:${data.length}` };
  }

  const discriminator = data.subarray(0, 8).toString('base64');
  if (discriminator !== OBSERVATION_DISCRIMINATOR_B64) {
    return { ok: false, reason: `discriminator_mismatch:${discriminator}` };
  }

  try {
    // The SDK owns the field semantics; we only add provenance and the
    // schema-version bytes it does not surface.
    const decoded = sdkDeserialize(data);

    const record: DecodedObservation = {
      epochIndex: decoded.epochIndex,
      observer: decoded.observer,
      pubkey,
      gatewayResults: Buffer.from(
        data.subarray(GATEWAY_RESULTS_OFFSET, GATEWAY_RESULTS_OFFSET + GATEWAY_RESULTS_BYTES)
      ),
      gatewayCount: decoded.gatewayCount,
      reportTxId: decoded.reportTxId,
      submittedAt: decoded.submittedAt,
      schemaVersion: {
        major: data.readUInt8(SCHEMA_MAJOR_OFFSET),
        minor: data.readUInt8(SCHEMA_MAJOR_OFFSET + 1),
        patch: data.readUInt8(SCHEMA_MAJOR_OFFSET + 2),
      },
      accountBytes: data.length,
      suspectTimestamp: isSuspectTimestamp(decoded.submittedAt),
    };

    if (!record.gatewayResults.equals(decoded.gatewayResults)) {
      // The SDK and the raw slice disagree — the layout moved under us.
      return { ok: false, reason: 'gateway_results_offset_mismatch' };
    }

    // gatewayCount is the DENOMINATOR of every similarity score and the length
    // of the masked prefix, so an out-of-range value does not merely look odd,
    // it manufactures findings: 0 makes every blob hash to the digest of an
    // empty buffer (a confidence-1.0 `identical_results` over zero compared
    // bytes), and > 3000 inflates the denominator until two maximally
    // different blobs score 0.95. Park the bytes rather than trust it.
    if (!isValidGatewayCount(record.gatewayCount)) {
      return { ok: false, reason: `gateway_count_out_of_range:${record.gatewayCount}` };
    }

    return { ok: true, record };
  } catch (error) {
    return { ok: false, reason: `deserialize_failed:${(error as Error).name}` };
  }
}

/** Populated once by {@link loadSdkDecoder}; keeps decode() synchronous. */
let sdkDeserializeImpl: ((data: Buffer) => SdkObservation) | null = null;

export interface SdkObservation {
  epochIndex: number;
  observer: string;
  gatewayResults: Buffer;
  gatewayCount: number;
  reportTxId: string;
  submittedAt: number;
}

function sdkDeserialize(data: Buffer): SdkObservation {
  if (!sdkDeserializeImpl) {
    throw new Error('SDK decoder not loaded — call loadSdkDecoder() during startup');
  }
  return sdkDeserializeImpl(data);
}

/**
 * The Epoch account as the SDK decodes it. Every scalar is a plain number —
 * the reward amounts are well under 2^53, so no bigint handling is needed.
 */
export interface SdkEpoch {
  epochIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  totalEligibleRewards: number;
  perGatewayReward: number;
  perObserverReward: number;
  rewardRate: number;
  activeGatewayCount: number;
  distributionIndex: number;
  tallyIndex: number;
  observerCount: number;
  nameCount: number;
  observationsSubmitted: number;
  rewardsDistributed: number;
  weightsTallied: number;
  prescriptionsDone: number;
  failureCounts: Uint16Array;
  hasObserved: Uint8Array;
  prescribedObservers: string[];
  prescribedObserverGateways: string[];
  prescribedNameHashes: Buffer[];
}

let sdkDeserializeEpochImpl: ((data: Buffer) => SdkEpoch) | null = null;

/** Load the SDK decoders once at startup so decoding itself stays synchronous. */
export async function loadSdkDecoder(): Promise<void> {
  const { deserializeObservation, deserializeEpoch } = await import('@ar.io/sdk');
  sdkDeserializeImpl = deserializeObservation as (data: Buffer) => SdkObservation;
  sdkDeserializeEpochImpl = deserializeEpoch as unknown as (data: Buffer) => SdkEpoch;
}

/** Install an epoch decoder directly. Tests use this; see {@link useSdkDecoder}. */
export function useSdkEpochDecoder(impl: ((data: Buffer) => SdkEpoch) | null): void {
  sdkDeserializeEpochImpl = impl;
}

/**
 * Install a decoder directly. Tests use this to exercise the validation and
 * provenance logic against synthetic accounts without importing the SDK or
 * touching the network; production always goes through {@link loadSdkDecoder}.
 */
export function useSdkDecoder(impl: ((data: Buffer) => SdkObservation) | null): void {
  sdkDeserializeImpl = impl;
}

/** `1 <= gatewayCount <= 3000`, integral. Anything else is not comparable. */
export function isValidGatewayCount(gatewayCount: number): boolean {
  return Number.isInteger(gatewayCount) && gatewayCount > 0 && gatewayCount <= MAX_GATEWAY_COUNT;
}

function isSuspectTimestamp(submittedAt: number): boolean {
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) return true;
  return submittedAt > Math.floor(Date.now() / 1000) + FUTURE_TIMESTAMP_TOLERANCE_SECONDS;
}

/**
 * Startup canary. A wrong discriminator returns zero accounts, which is
 * indistinguishable from a quiet network — so refuse to start instead.
 *
 * Checked against the Anchor derivation (`sha256('account:Observation')[0..8]`)
 * and, when resolvable, against the generated client constant that the SDK
 * itself decodes with.
 */
export async function assertDiscriminatorMatchesSdk(): Promise<void> {
  const derived = createHash('sha256').update('account:Observation').digest().subarray(0, 8);
  const derivedB64 = derived.toString('base64');

  if (derivedB64 !== OBSERVATION_DISCRIMINATOR_B64) {
    throw new Error(
      `Observation discriminator drift: hardcoded ${OBSERVATION_DISCRIMINATOR_B64} != ` +
        `anchor-derived ${derivedB64}. Refusing to start.`
    );
  }

  const generated = await loadGeneratedDiscriminator();
  if (generated && generated !== OBSERVATION_DISCRIMINATOR_B64) {
    throw new Error(
      `Observation discriminator drift: hardcoded ${OBSERVATION_DISCRIMINATOR_B64} != ` +
        `SDK client constant ${generated}. The account model changed. Refusing to start.`
    );
  }
}

/**
 * Best-effort read of `OBSERVATION_DISCRIMINATOR` from the Codama client the
 * SDK decodes with. Resolved through a computed specifier because the package
 * ships an `exports` map that this repo's `moduleResolution: node` cannot see.
 */
async function loadGeneratedDiscriminator(): Promise<string | null> {
  const specifier = '@ar.io/solana-contracts/gar';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      OBSERVATION_DISCRIMINATOR?: Uint8Array;
    };
    if (!mod.OBSERVATION_DISCRIMINATOR) return null;
    return Buffer.from(mod.OBSERVATION_DISCRIMINATOR).toString('base64');
  } catch {
    return null;
  }
}

/** A decoded Epoch account, flattened for storage. */
export interface DecodedEpoch {
  pubkey: string;
  accountBytes: number;
  epoch: SdkEpoch;
}

export type EpochDecodeOutcome =
  | { ok: true; value: DecodedEpoch }
  | { ok: false; reason: string };

/**
 * Decode one Epoch account.
 *
 * Deliberately thinner than {@link decodeObservationAccount}: an Epoch account
 * is written only by the program itself, so there is no adversarial observer
 * to guard against — the only realistic failure is a layout change, which the
 * `dataSize` filter on the fetch already turns into a zero-result. What is
 * left is to not let one malformed account abort the whole poll.
 */
export function decodeEpochAccount(account: RawObservationAccount): EpochDecodeOutcome {
  if (!sdkDeserializeEpochImpl) {
    return { ok: false, reason: 'epoch-decoder-not-loaded' };
  }

  let epoch: SdkEpoch;
  try {
    epoch = sdkDeserializeEpochImpl(account.data);
  } catch (error) {
    return { ok: false, reason: `decode-threw: ${(error as Error).message}` };
  }

  if (!Number.isInteger(epoch.epochIndex) || epoch.epochIndex < 0) {
    return { ok: false, reason: `bad-epoch-index: ${String(epoch.epochIndex)}` };
  }

  return {
    ok: true,
    value: {
      pubkey: account.pubkey,
      accountBytes: account.data.length,
      epoch,
    },
  };
}
