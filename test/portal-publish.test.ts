/**
 * The portal publisher: document shape, freshness bookkeeping, and the two
 * refusals that keep a bad cycle from destroying good data.
 *
 * No network. The snapshot is a fixture, exactly as the capture tests inject a
 * decoder rather than calling an RPC endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  markPortalPublishFailure,
  publishPortalDocuments,
  readPortalManifest,
} from '../src/publish/portal.js';
import {
  PORTAL_DOCUMENTS,
  PORTAL_SCHEMA_VERSION,
  inferNetwork,
  portalDocumentPath,
} from '../src/portal/contract.js';
import type { PortalSnapshot } from '../src/portal/fetch.js';

function snapshot(overrides: Partial<PortalSnapshot> = {}): PortalSnapshot {
  return {
    network: 'mainnet',
    host: 'example.quiknode.pro',
    programIds: {
      core: '73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh',
      gar: '89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf',
      arns: '2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ',
      ant: '2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5',
    },
    gateways: [{ gatewayAddress: 'gw-1', operatorStake: 50_000_000_000 }],
    vaults: [{ address: 'wallet-1', vaultId: 1, balance: 10 }],
    balances: [{ address: 'wallet-1', balance: 123 }],
    delegates: [{ address: 'wallet-2', gatewayAddress: 'gw-1', delegatedStake: 7 }],
    withdrawals: [
      { cursorId: 'wd-1', vaultId: '1', balance: 5, gatewayAddress: 'gw-1' },
    ],
    primaryNames: [{ name: 'alice', address: 'wallet-1' }],
    arnsRecords: [{ name: 'alice', processId: 'ant-1' }],
    arnsRecordCount: 2981,
    tokenSupply: { total: 1_000_000, circulating: 500_000 },
    demandFactor: 6.88,
    gatewayRegistrySettings: { delegates: { minStake: 10_000_000 } },
    ...overrides,
  };
}

/** Each test gets its own public dir; PUBLIC_DIR is read at call time. */
function withPublicDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'portal-publish-'));
  const previous = process.env.PUBLIC_DIR;
  process.env.PUBLIC_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function readDoc<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, portalDocumentPath(name as never)), 'utf8')) as T;
}

test('every document in the contract is written, with a gzip sibling', () => {
  withPublicDir((dir) => {
    publishPortalDocuments(snapshot());

    for (const name of [...PORTAL_DOCUMENTS, 'index'] as const) {
      const path = join(dir, portalDocumentPath(name));
      assert.ok(existsSync(path), `${name}.json was not written`);
      assert.ok(existsSync(`${path}.gz`), `${name}.json.gz was not written`);

      // The precompressed sibling must be the same bytes — a stale or
      // mismatched .gz is served preferentially and is invisible to anyone
      // testing without Accept-Encoding.
      assert.equal(
        gunzipSync(readFileSync(`${path}.gz`)).toString('utf8'),
        readFileSync(path, 'utf8'),
        `${name}.json.gz does not match its source`
      );
    }
  });
});

test('count is the array length, so a consumer cannot read a stale total', () => {
  withPublicDir((dir) => {
    publishPortalDocuments(
      snapshot({ gateways: [{ a: 1 }, { a: 2 }, { a: 3 }] as unknown[] })
    );

    const doc = readDoc<{ count: number; items: unknown[] }>(dir, 'gateways');
    assert.equal(doc.count, 3);
    assert.equal(doc.count, doc.items.length);
  });
});

test('one generatedAt is stamped across the whole set', () => {
  withPublicDir((dir) => {
    const manifest = publishPortalDocuments(snapshot());

    // Five documents each carrying their own write time would be
    // indistinguishable from a torn publish.
    for (const name of PORTAL_DOCUMENTS) {
      const doc = readDoc<{ generatedAt: string; schemaVersion: string }>(dir, name);
      assert.equal(doc.generatedAt, manifest.generatedAt, `${name} has a different generatedAt`);
      assert.equal(doc.schemaVersion, PORTAL_SCHEMA_VERSION);
    }
  });
});

test('the manifest digests match the bytes actually on disk', () => {
  withPublicDir((dir) => {
    const manifest = publishPortalDocuments(snapshot());

    for (const [name, entry] of Object.entries(manifest.documents)) {
      assert.ok(entry, `${name} missing from the manifest`);
      const bytes = readFileSync(join(dir, entry.path.replace(/^\//, '')));
      assert.equal(
        entry.bytes,
        bytes.length,
        `${name}: manifest byte count disagrees with the file`
      );
      // The server hands these digests out as ETags. If they do not describe
      // the bytes, caches serve the wrong body indefinitely.
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

test('summary carries counts and scalars without publishing the ArNS records', () => {
  withPublicDir((dir) => {
    publishPortalDocuments(snapshot());

    const doc = readDoc<{
      counts: Record<string, number>;
      demandFactor: number | null;
      tokenSupply: unknown;
    }>(dir, 'summary');

    assert.equal(doc.counts.arnsRecords, 2981);
    assert.equal(doc.counts.gateways, 1);
    assert.equal(doc.demandFactor, 6.88);
    assert.deepEqual(doc.tokenSupply, { total: 1_000_000, circulating: 500_000 });

    // ~3,000 records would be ~160 KB for a number nothing else reads.
    assert.equal(existsSync(join(dir, portalDocumentPath('arns' as never))), false);
  });
});

test('a failed cycle marks the manifest stale and leaves the documents alone', () => {
  withPublicDir((dir) => {
    publishPortalDocuments(snapshot());
    const before = readFileSync(join(dir, portalDocumentPath('gateways')), 'utf8');

    const first = markPortalPublishFailure();
    assert.equal(first?.freshness.stale, true);
    assert.equal(first?.freshness.consecutiveFailures, 1);

    const second = markPortalPublishFailure();
    assert.equal(second?.freshness.consecutiveFailures, 2, 'failures must accumulate');

    // The data is still the best available — only its age changed.
    assert.equal(readFileSync(join(dir, portalDocumentPath('gateways')), 'utf8'), before);
    assert.equal(
      second?.generatedAt,
      first?.generatedAt,
      'generatedAt still describes the documents, which did not change'
    );
  });
});

test('a successful cycle clears the failure state', () => {
  withPublicDir(() => {
    publishPortalDocuments(snapshot());
    markPortalPublishFailure();
    markPortalPublishFailure();

    const recovered = publishPortalDocuments(snapshot());
    assert.equal(recovered.freshness.stale, false);
    assert.equal(recovered.freshness.consecutiveFailures, 0);
  });
});

test('marking a failure before anything is published does not invent a manifest', () => {
  withPublicDir(() => {
    // Claiming documents that do not exist would make a cold start look like
    // a stale publisher.
    assert.equal(markPortalPublishFailure(), null);
    assert.equal(readPortalManifest(), null);
  });
});

test('a corrupt manifest is treated as absent rather than crashing the publisher', () => {
  withPublicDir((dir) => {
    publishPortalDocuments(snapshot());
    writeFileSync(join(dir, portalDocumentPath('index')), '{ not json');

    assert.equal(readPortalManifest(), null);
    assert.equal(markPortalPublishFailure(), null);
  });
});

test('network inference never depends on the token in an endpoint path', () => {
  assert.equal(inferNetwork('https://x.solana-mainnet.quiknode.pro/abc123/'), 'mainnet');
  assert.equal(inferNetwork('https://x.solana-devnet.quiknode.pro/abc123/'), 'devnet');
  assert.equal(inferNetwork('http://127.0.0.1:8899'), 'localnet');
  assert.equal(inferNetwork('https://api.testnet.solana.com'), 'testnet');
  assert.equal(inferNetwork('https://example.com/rpc'), 'unknown');
  assert.equal(inferNetwork('devnet'), 'devnet', 'PORTAL_NETWORK is passed through the same path');
  assert.equal(inferNetwork('not a url at all'), 'unknown');
});

test('every document and the manifest name the programs they were derived from', () => {
  withPublicDir((dir) => {
    const manifest = publishPortalDocuments(snapshot());

    // `network` alone is not self-describing: program ids are per-cluster and
    // move on a redeploy, and decoding accounts from the wrong program yields
    // plausible nonsense rather than an error.
    assert.deepEqual(manifest.programIds, snapshot().programIds);

    for (const name of PORTAL_DOCUMENTS) {
      const raw = readFileSync(join(dir, portalDocumentPath(name)), 'utf8');
      const doc = JSON.parse(raw) as { programIds?: unknown; network?: string };
      assert.deepEqual(
        doc.programIds,
        snapshot().programIds,
        `${name}.json must carry programIds — documents are fetched and cached independently of the manifest`
      );
      assert.equal(doc.network, 'mainnet', `${name}.json must carry its network`);
    }
  });
});
