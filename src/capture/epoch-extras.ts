/**
 * The five Epoch account fields the SDK's own decoder throws away.
 *
 * `deserializeEpoch()` from `@ar.io/sdk` returns 21 fields. The on-chain
 * account has 29. The difference is not an accident of ours — the SDK's
 * projection simply drops them, and because capture decodes through the SDK,
 * they were never stored:
 *
 *   totalCompositeWeightLo/Hi  the u128 denominator for weighted reward share
 *   hashchain                  the frozen entropy prescribed observers derive from
 *   observationsClosed         the protocol stating the reporting window is shut
 *   versionBytes               the account layout version
 *
 * These are unrecoverable once an epoch closes: `close_epoch` is permissionless
 * and reclaims the account, so whatever is on chain at poll time is all there
 * will ever be. At the time of writing 44 of 53 known epochs had already lost
 * them.
 *
 * Decoded through the contracts package's raw Codama decoder rather than the
 * SDK, and kept in its OWN module and its own try/catch on purpose: the
 * existing 21 fields keep flowing through the SDK path untouched, so a change
 * or failure here degrades to nulls instead of putting capture at risk. Capture
 * is the durable record; it must keep recording what it can.
 */

/** The five fields, shaped for storage. */
export interface EpochExtras {
  /**
   * Total composite weight for the epoch, as a DECIMAL STRING.
   *
   * On chain it is a u128 split into two u64s. A u128 does not fit in a JS
   * number and JSON has no bigint, so it is carried as a string end to end
   * rather than silently losing precision at 2^53.
   */
  totalCompositeWeight: string | null;
  /** 32 bytes of frozen entropy; prescribed observers derive from it. */
  hashchain: Buffer | null;
  /** The protocol's own statement that the observation window is closed. */
  observationsClosed: boolean | null;
  /** Account layout version, `major.minor.patch`. A drift canary. */
  version: string | null;
}

export const EMPTY_EPOCH_EXTRAS: EpochExtras = {
  totalCompositeWeight: null,
  hashchain: null,
  observationsClosed: null,
  version: null,
};

interface RawEpochExtras {
  totalCompositeWeightLo?: bigint | number;
  totalCompositeWeightHi?: bigint | number;
  hashchain?: Uint8Array;
  observationsClosed?: number | boolean;
  versionBytes?: Uint8Array;
}

type ExtrasDecoder = (data: Buffer) => RawEpochExtras;

let decodeImpl: ExtrasDecoder | null = null;

/**
 * Load the raw Codama decoder once at startup.
 *
 * Resolved through a computed specifier for the same reason
 * `loadGeneratedDiscriminator` does it: the contracts package ships an
 * `exports` map this repo's `moduleResolution: node` cannot see.
 */
export async function loadEpochExtrasDecoder(): Promise<void> {
  const specifier = '@ar.io/solana-contracts/gar';
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    getEpochDecoder?: () => { decode(data: Uint8Array): RawEpochExtras };
  };
  if (!mod.getEpochDecoder) {
    decodeImpl = null;
    return;
  }
  const decoder = mod.getEpochDecoder();
  decodeImpl = (data: Buffer) => decoder.decode(data);
}

/** Install a decoder directly. Tests use this; production uses the loader. */
export function useEpochExtrasDecoder(impl: ExtrasDecoder | null): void {
  decodeImpl = impl;
}

/**
 * Combine the two u64 halves into one u128 decimal string.
 *
 * `hi * 2^64 + lo`, in BigInt throughout. Returns null when either half is
 * absent, because a half-read weight is worse than no weight: it would look
 * like a plausible number.
 */
export function combineU128(
  lo: bigint | number | undefined,
  hi: bigint | number | undefined,
): string | null {
  if (lo === undefined || hi === undefined) return null;
  try {
    return ((BigInt(hi) << 64n) + BigInt(lo)).toString();
  } catch {
    return null;
  }
}

/** Render a 3-byte version as `major.minor.patch`. */
export function formatVersion(bytes: Uint8Array | undefined): string | null {
  if (!bytes || bytes.length < 3) return null;
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

/**
 * Decode the five extras from a raw Epoch account.
 *
 * Never throws. A decode failure yields all-nulls, which the publish side
 * reports as absent rather than as zero — a zero composite weight or a
 * zeroed hashchain would both read as real values.
 */
export function decodeEpochExtras(data: Buffer): EpochExtras {
  if (!decodeImpl) return EMPTY_EPOCH_EXTRAS;

  let raw: RawEpochExtras;
  try {
    raw = decodeImpl(data);
  } catch {
    return EMPTY_EPOCH_EXTRAS;
  }

  return {
    totalCompositeWeight: combineU128(raw.totalCompositeWeightLo, raw.totalCompositeWeightHi),
    hashchain: raw.hashchain ? Buffer.from(raw.hashchain) : null,
    observationsClosed:
      raw.observationsClosed === undefined ? null : Boolean(raw.observationsClosed),
    version: formatVersion(raw.versionBytes),
  };
}
