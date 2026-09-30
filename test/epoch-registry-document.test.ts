/**
 * The registry slot order document — the key to every verdict bitmap.
 *
 * An observation publishes `gatewayResultsBase64`, a bitmap indexed by gateway
 * registry SLOT. The slot order was captured but never published, so a consumer
 * could count how many gateways an observer failed and name none of them. The
 * epoch document even shipped a `registryDigest` — a checksum for a key that
 * was not being served.
 *
 * These tests pin the projection and, more importantly, the decode contract:
 * the whole point is that bit `i` resolves to `gateways[i]`, so there is a test
 * that actually decodes a bitmap end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistryDocument } from '../src/observers/documents.js';
import { GATEWAY_RESULTS_ENCODING, SCHEMA_VERSION } from '../src/publish/contract.js';
import { routeToFile } from '../src/server/index.js';
import type { RegistrySnapshot } from '../src/observers/types.js';

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
  epochIndex: 559,
  gatewayCount: 3,
  capturedAt: 1_759_104_250,
  capturedAtSlot: 500_465_551,
  digest: '7604dde571d4ba93',
  registryPubkey: 'RegistryPubkey1111111111111111111111111111',
  slots: ['GatewayA', 'GatewayB', 'GatewayC'],
  inEpoch: true,
  ...over,
});

test('projects the snapshot, preserving slot order exactly', () => {
  const doc = buildRegistryDocument(snapshot());

  assert.equal(doc.epochIndex, 559);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.gatewayCount, 3);
  assert.equal(doc.digest, '7604dde571d4ba93');
  assert.equal(doc.registryPubkey, 'RegistryPubkey1111111111111111111111111111');
  assert.equal(doc.capturedAtUnix, 1_759_104_250);
  assert.equal(doc.capturedAtSlot, 500_465_551);
  assert.equal(doc.encoding, GATEWAY_RESULTS_ENCODING);
  // Order IS the payload. Any reordering silently misattributes every verdict.
  assert.deepEqual(doc.gateways, ['GatewayA', 'GatewayB', 'GatewayC']);
});

test('an in-epoch snapshot is not approximate', () => {
  const doc = buildRegistryDocument(snapshot({ inEpoch: true }));
  assert.equal(doc.inEpoch, true);
  assert.equal(doc.approximate, false);
});

test('a post-hoc snapshot is published but flagged approximate', () => {
  // Epochs 510 and 511 on the live box. Withholding them would hide that their
  // bitmaps are undecodable; publishing them unflagged would misattribute
  // verdicts. Flagged is the only honest option.
  const doc = buildRegistryDocument(snapshot({ inEpoch: false }));
  assert.equal(doc.inEpoch, false);
  assert.equal(doc.approximate, true);
});

test('approximate is always the strict inverse of inEpoch', () => {
  for (const inEpoch of [true, false]) {
    const doc = buildRegistryDocument(snapshot({ inEpoch }));
    assert.equal(doc.approximate, !doc.inEpoch);
  }
});

test('a bitmap decodes to gateway addresses using the published order', () => {
  // The end-to-end reason this document exists. Bits 0 and 2 set, bit 1 clear,
  // LSB-first.
  //
  // POLARITY: a set bit means HEALTHY; the cleared bit is the failure. So
  // GatewayA and GatewayC passed and GatewayB failed — the opposite of the
  // reading you get from skimming the bitmap. hamming.ts documents `0 =
  // failed`, and the chain's per-slot `failure_counts` matches the cleared-bit
  // count across observers for all 553 slots of epoch 559.
  const doc = buildRegistryDocument(snapshot());
  const blob = Buffer.from([0b0000_0101]);
  const bit = (i: number) => (blob[i >> 3] >> (i & 7)) & 1;

  const passed = doc.gateways.filter((_, i) => bit(i) === 1);
  const failed = doc.gateways.filter((_, i) => bit(i) === 0);

  assert.deepEqual(passed, ['GatewayA', 'GatewayC']);
  assert.deepEqual(failed, ['GatewayB'], 'the CLEARED bit is the failure');
});

test('padding past gatewayCount is zero, which would read as failure', () => {
  // Why the meaningful-bytes bound is load-bearing under this polarity: an
  // unmasked tail of zeroes looks exactly like a sweep of failing gateways.
  const doc = buildRegistryDocument(snapshot());
  const blob = Buffer.alloc(8); // all zero, far longer than 3 slots
  const bit = (i: number) => (blob[i >> 3] >> (i & 7)) & 1;

  const failedWithinRange = doc.gateways.filter((_, i) => bit(i) === 0);
  assert.equal(failedWithinRange.length, 3, 'bounded by the published slot count');
  assert.equal(doc.gateways.length, 3, 'never decode past gateways.length');
});

test('the reverse question is answerable: which slot is a given gateway', () => {
  // "Which observers failed gateway X in epoch N" was impossible before: you
  // find its slot here, then test that bit (cleared = failed) per observation.
  const doc = buildRegistryDocument(snapshot());
  assert.equal(doc.gateways.indexOf('GatewayB'), 1);
});

test('an empty registry projects to an empty array, not a throw', () => {
  const doc = buildRegistryDocument(snapshot({ slots: [], gatewayCount: 0 }));
  assert.deepEqual(doc.gateways, []);
  assert.equal(doc.gatewayCount, 0);
});

test('the document survives JSON round-tripping', () => {
  const round = JSON.parse(JSON.stringify(buildRegistryDocument(snapshot())));
  assert.deepEqual(round.gateways, ['GatewayA', 'GatewayB', 'GatewayC']);
  assert.equal(round.approximate, false);
});

// --- routing ----------------------------------------------------------------

test('the registry route maps to the published file', () => {
  assert.equal(routeToFile('/api/v1/registry/559.json'), 'api/v1/registry/559.json');
});

test('the registry route rejects anything that is not an epoch index', () => {
  // Same gate as the epoch documents: a typo must be a 404, not a path probe.
  for (const bad of [
    '/api/v1/registry/../index.json',
    '/api/v1/registry/abc.json',
    '/api/v1/registry/-1.json',
    '/api/v1/registry/5 9.json',
    '/api/v1/registry/.json',
  ]) {
    assert.equal(routeToFile(bad), null, `${bad} must not route`);
  }
});

test('the registry route does not swallow nested paths', () => {
  assert.equal(routeToFile('/api/v1/registry/559/extra.json'), null);
});
