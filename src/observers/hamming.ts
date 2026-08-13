/**
 * Masked Hamming distance over observation result blobs.
 *
 * This is the only new analytical primitive in the whole capability, and every
 * rule below is load-bearing:
 *
 *  1. Compare only the first `ceil(gatewayCount/8)` bytes. At
 *     `gatewayCount = 643` that is 81 of 375 bytes. Bytes 81–374 are constant
 *     zero padding; including them inflates every score by ~4.6x and makes two
 *     unrelated observers look ~78% identical before any real signal.
 *  2. Mask the final partial byte to the low `gatewayCount % 8` bits. Those
 *     trailing bits are padding too, and `0 = failed`, so unmasked padding
 *     reads as a real "fail" vote.
 *  3. The denominator is `gatewayCount` bits — not bytes, not 3000.
 *  4. Different `gatewayCount` between two observations => compare over the
 *     minimum and say so; never silently pick one.
 *  5. Never compare with `===` or by digest alone. The seven suspicious
 *     epoch-511 blobs were all distinct.
 *
 * The blob's bit semantics are never interpreted here — only `gatewayCount`, a
 * decoded scalar field, is used. This is byte comparison, not decoding.
 */

import { createHash } from 'crypto';

export interface SimilarityResult {
  hammingBits: number; // differing bits within the meaningful prefix
  hammingBytes: number; // differing bytes (reported for continuity)
  comparedBits: number; // === gatewayCount (or the minimum of two)
  meaningfulBytes: number; // === ceil(comparedBits / 8)
  similarity: number; // 1 - hammingBits / comparedBits
  gatewayCountMismatch: boolean;
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];
}

/**
 * Number of meaningful bytes for a bit count.
 *
 * Non-finite or negative counts collapse to 0 rather than producing NaN — a
 * NaN length silently turns every downstream slice into an empty buffer.
 */
export function meaningfulBytes(gatewayCount: number): number {
  if (!Number.isFinite(gatewayCount)) return 0;
  return Math.ceil(Math.max(0, gatewayCount) / 8);
}

/** Mask for the final partial byte: low `gatewayCount % 8` bits, LSB-first. */
function finalByteMask(gatewayCount: number): number {
  const remainder = gatewayCount % 8;
  return remainder === 0 ? 0xff : (1 << remainder) - 1;
}

/**
 * The comparable prefix of a blob: meaningful bytes with the trailing partial
 * byte masked. Two observations with the same prefix voted identically.
 */
export function maskedPrefix(blob: Buffer, gatewayCount: number): Buffer {
  const nominal = meaningfulBytes(gatewayCount);
  const bytes = Math.min(nominal, blob.length);
  const prefix = Buffer.from(blob.subarray(0, bytes));

  // The mask belongs to the NOMINAL final byte. When the blob is shorter than
  // the prefix the count claims, the last byte we actually have is a full data
  // byte, and masking it would destroy real bits.
  if (bytes > 0 && bytes === nominal) {
    prefix[bytes - 1] &= finalByteMask(gatewayCount);
  }
  return prefix;
}

/** sha256 of the masked prefix — the grouping key for identical results. */
export function maskedDigest(blob: Buffer, gatewayCount: number): string {
  return createHash('sha256').update(maskedPrefix(blob, gatewayCount)).digest('hex');
}

/**
 * Bit-level distance between two blobs over their meaningful prefix.
 * Pass both gateway counts when they may differ.
 */
export function maskedHamming(
  a: Buffer,
  b: Buffer,
  gatewayCount: number,
  gatewayCountB?: number
): SimilarityResult {
  const countB = gatewayCountB ?? gatewayCount;
  const sanitize = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const comparedBits = Math.min(sanitize(gatewayCount), sanitize(countB));
  const bytes = meaningfulBytes(comparedBits);

  const prefixA = maskedPrefix(a, comparedBits);
  const prefixB = maskedPrefix(b, comparedBits);

  let hammingBits = 0;
  let hammingBytes = 0;
  for (let i = 0; i < bytes; i++) {
    const xor = (prefixA[i] ?? 0) ^ (prefixB[i] ?? 0);
    if (xor !== 0) {
      hammingBytes++;
      hammingBits += POPCOUNT[xor];
    }
  }

  return {
    hammingBits,
    hammingBytes,
    comparedBits,
    meaningfulBytes: bytes,
    // No compared bits means no evidence — and "no evidence" must never read
    // as "maximum similarity". A zero (or absent) gatewayCount would otherwise
    // make every blob look perfectly identical to every other one, which is
    // exactly how a confidence-1.0 finding gets manufactured out of nothing.
    similarity: comparedBits > 0 ? 1 - hammingBits / comparedBits : 0,
    gatewayCountMismatch: gatewayCount !== countB,
  };
}

/** Convenience wrapper when only the score is wanted. */
export function similarity(
  a: Buffer,
  b: Buffer,
  gatewayCount: number,
  gatewayCountB?: number
): number {
  return maskedHamming(a, b, gatewayCount, gatewayCountB).similarity;
}

export interface PairSimilarity<T> {
  a: T;
  b: T;
  indexA: number;
  indexB: number;
  result: SimilarityResult;
}

/**
 * All-pairs similarity. 31 observations is 465 pairs of 81 bytes — trivial, so
 * this is recomputed every cycle and nothing is cached.
 */
export function pairwiseMatrix<T extends { gatewayResults: Buffer; gatewayCount: number }>(
  items: T[]
): Array<PairSimilarity<T>> {
  const pairs: Array<PairSimilarity<T>> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push({
        a: items[i],
        b: items[j],
        indexA: i,
        indexB: j,
        result: maskedHamming(
          items[i].gatewayResults,
          items[j].gatewayResults,
          items[i].gatewayCount,
          items[j].gatewayCount
        ),
      });
    }
  }
  return pairs;
}

/** Connected components over an undirected edge list. */
export function connectedComponents(nodes: string[], edges: Array<[string, string]>): string[][] {
  const parent = new Map<string, string>(nodes.map((n) => [n, n]));

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = x;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node);
    const group = groups.get(root) ?? [];
    group.push(node);
    groups.set(root, group);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}
