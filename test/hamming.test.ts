/**
 * Masked Hamming distance.
 *
 * These assertions encode the four rules the metric is worthless without:
 * compare only the meaningful prefix, mask the partial final byte, divide by
 * bits (not bytes), and never let "nothing to compare" read as "identical".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectedComponents,
  maskedDigest,
  maskedHamming,
  maskedPrefix,
  meaningfulBytes,
  pairwiseMatrix,
  similarity,
} from '../src/observers/hamming.js';
import { BLOB_BYTES, GATEWAY_COUNT, MEANINGFUL_BYTES, blob, flipBits } from './helpers.js';

test('meaningfulBytes is ceil(gatewayCount / 8)', () => {
  assert.equal(meaningfulBytes(GATEWAY_COUNT), MEANINGFUL_BYTES);
  assert.equal(meaningfulBytes(8), 1);
  assert.equal(meaningfulBytes(9), 2);
  assert.equal(meaningfulBytes(0), 0);
  assert.equal(meaningfulBytes(-5), 0);
  assert.equal(meaningfulBytes(Number.NaN), 0);
});

test('identical blobs are 100% similar with zero differing bits', () => {
  const a = blob(0xa5);
  const b = Buffer.from(a);

  const result = maskedHamming(a, b, GATEWAY_COUNT);
  assert.equal(result.hammingBits, 0);
  assert.equal(result.hammingBytes, 0);
  assert.equal(result.similarity, 1);
  assert.equal(result.comparedBits, GATEWAY_COUNT);
  assert.equal(result.meaningfulBytes, MEANINGFUL_BYTES);
  assert.equal(result.gatewayCountMismatch, false);
  assert.equal(maskedDigest(a, GATEWAY_COUNT), maskedDigest(b, GATEWAY_COUNT));
});

test('~97% identical blobs score just under 0.98 and stay distinct', () => {
  // 16 differing bits of 643 => 1 - 16/643 = 0.97511...
  const a = blob(0xa5);
  const b = flipBits(a, 16);

  const result = maskedHamming(a, b, GATEWAY_COUNT);
  assert.equal(result.hammingBits, 16);
  assert.ok(Math.abs(result.similarity - (1 - 16 / GATEWAY_COUNT)) < 1e-12);
  assert.ok(result.similarity > 0.97 && result.similarity < 0.98);

  // The epoch-511 lesson: near-identical blobs are NOT equal blobs. Anything
  // grouping by digest alone finds nothing here.
  assert.notEqual(maskedDigest(a, GATEWAY_COUNT), maskedDigest(b, GATEWAY_COUNT));
  assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('the constant zero padding is excluded from the comparison', () => {
  const a = blob(0xa5);
  const b = Buffer.from(a);
  // Scribble all over the padding region: it must not move the score at all.
  b.fill(0xff, MEANINGFUL_BYTES, BLOB_BYTES);

  const result = maskedHamming(a, b, GATEWAY_COUNT);
  assert.equal(result.hammingBits, 0);
  assert.equal(result.similarity, 1);
  assert.equal(maskedDigest(a, GATEWAY_COUNT), maskedDigest(b, GATEWAY_COUNT));
});

test('the partial final byte is masked to the low gatewayCount % 8 bits', () => {
  // 643 % 8 === 3, so only the low three bits of byte 80 are real votes.
  const a = blob(0xa5);
  const b = Buffer.from(a);
  b[MEANINGFUL_BYTES - 1] = 0x03 | 0xf8; // set every padding bit of the partial byte

  const result = maskedHamming(a, b, GATEWAY_COUNT);
  assert.equal(result.hammingBits, 0, 'padding bits inside the final byte must not count');

  const prefix = maskedPrefix(b, GATEWAY_COUNT);
  assert.equal(prefix.length, MEANINGFUL_BYTES);
  assert.equal(prefix[MEANINGFUL_BYTES - 1], 0x03);
});

test('a blob shorter than the nominal prefix keeps its real bits', () => {
  // The mask belongs to the nominal final byte; applying it to whatever byte a
  // truncation landed on destroys real data.
  const short = Buffer.alloc(3, 0xff);
  const prefix = maskedPrefix(short, GATEWAY_COUNT);

  assert.equal(prefix.length, 3);
  assert.equal(prefix.toString('hex'), 'ffffff', 'no mask applies to a truncated blob');
});

test('differing gateway counts compare over the minimum and say so', () => {
  const a = blob(0xa5);
  const b = blob(0xa5);

  const result = maskedHamming(a, b, GATEWAY_COUNT, 600);
  assert.equal(result.comparedBits, 600);
  assert.equal(result.meaningfulBytes, 75);
  assert.equal(result.gatewayCountMismatch, true);
});

test('zero compared bits scores 0, not 1 — no evidence is not identity', () => {
  const a = Buffer.alloc(BLOB_BYTES, 0xff);
  const b = Buffer.alloc(BLOB_BYTES, 0x00);

  // Maximally different blobs. A gatewayCount of 0 used to make these compare
  // as perfectly identical, which is how a confidence-1.0 finding gets
  // manufactured out of an empty buffer.
  const zero = maskedHamming(a, b, 0);
  assert.equal(zero.comparedBits, 0);
  assert.equal(zero.similarity, 0);

  assert.equal(similarity(a, b, Number.NaN), 0);
  assert.equal(similarity(a, b, -5), 0);
});

test('empty blobs are handled without throwing', () => {
  const empty = Buffer.alloc(0);
  const result = maskedHamming(empty, empty, GATEWAY_COUNT);

  assert.equal(result.hammingBits, 0);
  assert.equal(result.comparedBits, GATEWAY_COUNT);
  assert.equal(result.similarity, 1, 'two empty prefixes really are the same prefix');
  assert.equal(maskedDigest(empty, GATEWAY_COUNT), maskedDigest(empty, GATEWAY_COUNT));
});

test('an out-of-range gatewayCount cannot inflate similarity past reality', () => {
  const a = Buffer.alloc(BLOB_BYTES, 0xff);
  const b = Buffer.alloc(BLOB_BYTES, 0x00);

  // 65535 claimed bits vs 3000 real ones: the denominator is nonsense, so the
  // score is nonsense (0.954). decode() is what must reject this — assert the
  // hazard is real so the guard is never quietly removed.
  const bogus = maskedHamming(a, b, 65535);
  assert.ok(bogus.similarity > 0.9, 'documents WHY decode rejects out-of-range counts');

  // Within range, the same two blobs are correctly maximally different.
  const sane = maskedHamming(a, b, 3000);
  assert.equal(sane.similarity, 0);
});

test('pairwiseMatrix produces every unordered pair once', () => {
  const items = [0xa5, 0x5a, 0x33].map((fill) => ({
    gatewayResults: blob(fill),
    gatewayCount: GATEWAY_COUNT,
  }));

  const pairs = pairwiseMatrix(items);
  assert.equal(pairs.length, 3);
  assert.deepEqual(
    pairs.map((p) => `${p.indexA}-${p.indexB}`),
    ['0-1', '0-2', '1-2']
  );
});

test('connectedComponents returns only groups larger than one', () => {
  const groups = connectedComponents(
    ['a', 'b', 'c', 'd'],
    [
      ['a', 'b'],
      ['b', 'c'],
    ]
  );

  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort(), ['a', 'b', 'c']);
});
