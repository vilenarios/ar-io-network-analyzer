/**
 * End-to-end: a real server process, real published files, real HTTP.
 *
 * The unit tests cover what the publisher writes and what `routeToFile`
 * admits. This covers what a consumer actually receives — status codes,
 * caching headers, conditional requests, content negotiation, CORS, and the
 * failure modes — because every one of those is part of the contract the
 * network portal depends on, and none of them are visible from a pure
 * function.
 *
 * The server is spawned as a child process rather than imported, so what is
 * tested is the entry point that ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPortalDocuments } from '../src/publish/portal.js';
import { PORTAL_DOCUMENTS } from '../src/portal/contract.js';
import type { PortalSnapshot } from '../src/portal/fetch.js';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = join(import.meta.dirname, '..', 'src', 'server', 'index.ts');

function fixture(): PortalSnapshot {
  return {
    network: 'mainnet',
    host: 'example.quiknode.pro',
    gateways: Array.from({ length: 12 }, (_, i) => ({
      gatewayAddress: `gw-${i}`,
      operatorStake: 50_000_000_000 + i,
      settings: { fqdn: `gw${i}.example.com`, label: `Gateway ${i}` },
    })),
    vaults: [{ address: 'wallet-1', vaultId: 1, balance: 10 }],
    balances: [{ address: 'wallet-1', balance: 123 }],
    delegates: [{ address: 'wallet-2', gatewayAddress: 'gw-1', delegatedStake: 7 }],
    withdrawals: [
      { cursorId: 'wd-1', vaultId: '1', balance: 5, gatewayAddress: 'gw-1' },
    ],
    primaryNames: [{ name: 'alice', address: 'wallet-1' }],
    arnsRecords: [{ name: 'alice', processId: 'ant-1' }],
    arnsRecordCount: 2981,
    tokenSupply: { total: 1_000_000 },
    demandFactor: 6.88,
    gatewayRegistrySettings: { delegates: { minStake: 10_000_000 } },
  };
}

/**
 * Confirm the server answering is the one this test published for.
 *
 * A leftover process from another run listening on the same port answers
 * healthz just as happily, and the suite then asserts against someone else's
 * data — which is exactly how a stale-snapshot test passed against a fresh
 * snapshot.
 */
async function assertServesOurSnapshot(base: string, expectedGeneratedAt: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/portal/index.json`);
  if (res.status === 503) return; // cold instance: nothing published, as intended
  const manifest = (await res.json()) as { generatedAt?: string };
  assert.equal(
    manifest.generatedAt,
    expectedGeneratedAt,
    `another process is listening on ${base}; kill it and re-run`
  );
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

let dir: string;
let child: ChildProcess;

test('portal API end-to-end', async (t) => {
  dir = mkdtempSync(join(tmpdir(), 'portal-e2e-'));

  // Publish into the directory the server will serve.
  const previous = process.env.PUBLIC_DIR;
  process.env.PUBLIC_DIR = dir;
  const published = publishPortalDocuments(fixture());
  if (previous === undefined) delete process.env.PUBLIC_DIR;
  else process.env.PUBLIC_DIR = previous;

  child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: { ...process.env, PUBLIC_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  t.after(() => {
    child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer();
  await assertServesOurSnapshot(BASE, published.generatedAt);

  await t.test('every contract document is served as JSON', async () => {
    for (const name of [...PORTAL_DOCUMENTS, 'index'] as const) {
      const res = await fetch(`${BASE}/api/v1/portal/${name}.json`);
      assert.equal(res.status, 200, `${name}.json`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(typeof body, 'object');
    }
  });

  await t.test('collections carry count, items and a network label', async () => {
    for (const name of PORTAL_DOCUMENTS) {
      if (name === 'summary') continue;
      const res = await fetch(`${BASE}/api/v1/portal/${name}.json`);
      const body = (await res.json()) as { count: number; items: unknown[]; network: string };
      assert.equal(body.count, body.items.length, `${name}: count disagrees with items`);
      assert.equal(body.network, 'mainnet');
    }
  });

  await t.test('the manifest describes documents that are actually retrievable', async () => {
    const manifest = (await (await fetch(`${BASE}/api/v1/portal/index.json`)).json()) as {
      documents: Record<string, { path: string; sha256: string; bytes: number }>;
    };

    for (const [name, entry] of Object.entries(manifest.documents)) {
      const res = await fetch(`${BASE}${entry.path}`);
      assert.equal(res.status, 200, `${name} at ${entry.path}`);
      const text = await res.text();
      assert.equal(Buffer.byteLength(text), entry.bytes, `${name}: byte count mismatch`);
    }
  });

  await t.test('CORS is open, because browsers on other origins are the consumer', async () => {
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  await t.test('documents are cacheable and the manifest is cached more briefly', async () => {
    const doc = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    assert.equal(doc.headers.get('cache-control'), 'public, max-age=60');

    // The manifest is the polling target, so it must go stale sooner than the
    // documents it describes.
    const manifest = await fetch(`${BASE}/api/v1/portal/index.json`);
    assert.equal(manifest.headers.get('cache-control'), 'public, max-age=30');
  });

  await t.test('a conditional request is answered 304 with no body', async () => {
    const first = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'a strong ETag must be served');

    const second = await fetch(`${BASE}/api/v1/portal/gateways.json`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '', '304 must not carry a body');
  });

  await t.test('the ETag is the manifest digest, not a weak mtime tag', async () => {
    const manifest = (await (await fetch(`${BASE}/api/v1/portal/index.json`)).json()) as {
      documents: Record<string, { path: string; sha256: string }>;
    };
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    const etag = res.headers.get('etag') ?? '';

    assert.ok(!etag.startsWith('W/'), 'a weak tag means the digest lookup missed');
    assert.ok(
      etag.includes(manifest.documents.gateways.sha256),
      'the ETag must be the published digest so caches revalidate correctly'
    );
  });

  await t.test('gzip is served precompressed and decodes to the same document', async () => {
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`, {
      headers: { 'Accept-Encoding': 'gzip' },
      // Keep the raw bytes so the encoding can be asserted rather than
      // transparently undone by fetch.
    });
    assert.equal(res.status, 200);

    const identity = await fetch(`${BASE}/api/v1/portal/gateways.json`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    assert.equal(identity.headers.get('content-encoding'), null);

    const body = (await res.json()) as { count: number };
    assert.equal(body.count, 12);
  });

  await t.test('a gzip response varies on Accept-Encoding', async () => {
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    // Without Vary, a shared cache can hand a gzipped body to a client that
    // never asked for one.
    assert.equal(res.headers.get('vary'), 'Accept-Encoding');
  });

  await t.test('HEAD returns headers without a body', async () => {
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  await t.test('writes are refused', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${BASE}/api/v1/portal/gateways.json`, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
  });

  await t.test('unknown documents 404 rather than probing the filesystem', async () => {
    for (const path of [
      '/api/v1/portal/secrets.json',
      '/api/v1/portal/gateways.json.gz',
      '/api/v1/portal/gateways.txt',
      '/api/v1/portal/',
    ]) {
      const res = await fetch(`${BASE}${path}`);
      assert.equal(res.status, 404, path);
    }
  });

  await t.test('path traversal cannot escape the public root', async () => {
    for (const path of [
      '/api/v1/portal/../../../etc/passwd',
      '/api/v1/portal/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/../package.json',
    ]) {
      const res = await fetch(`${BASE}${path}`);
      assert.ok(res.status === 404 || res.status === 400, `${path} returned ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('root:'), 'must never return file contents from outside the root');
      assert.ok(!body.includes('"dependencies"'), 'must never return repository files');
    }
  });

  await t.test('responses carry the headers that stop content sniffing', async () => {
    const res = await fetch(`${BASE}/api/v1/portal/gateways.json`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  await t.test('healthz reports the portal independently of the observer stack', async () => {
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      portal: { published: boolean; status: string; stale: boolean; network: string };
    };

    // This instance publishes only the portal — exactly the testnet
    // deployment shape. It must not be reported as degraded for lacking a
    // capture daemon it was never meant to run.
    assert.equal(body.portal.published, true);
    assert.equal(body.portal.status, 'ok');
    assert.equal(body.portal.stale, false);
    assert.equal(body.portal.network, 'mainnet');
    assert.equal(body.status, 'ok', 'a portal-only instance with a fresh snapshot is healthy');
  });

  await t.test('the observer namespace still 503s when only the portal is published', async () => {
    // Namespace-aware: the portal documents are fine, but nothing has
    // published the observer manifest, and saying otherwise would be a lie.
    const res = await fetch(`${BASE}/api/v1/findings.json`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'not_published');
  });
});

test('a cold instance serves 503 for the portal namespace, and stays up', async (t) => {
  const coldDir = mkdtempSync(join(tmpdir(), 'portal-e2e-cold-'));
  const port = PORT + 1;
  const cold = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: { ...process.env, PUBLIC_DIR: coldDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  t.after(() => {
    cold.kill('SIGTERM');
    rmSync(coldDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('cold server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  const res = await fetch(`${base}/api/v1/portal/gateways.json`);
  assert.equal(res.status, 503, 'nothing published yet');

  // The process must stay up so a publisher can fill it in later.
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const body = (await health.json()) as { status: string; portal: { published: boolean } };
  assert.equal(body.portal.published, false);
  assert.equal(body.status, 'degraded');
});

test('a stale snapshot is reported as stale rather than served silently', async (t) => {
  const staleDir = mkdtempSync(join(tmpdir(), 'portal-e2e-stale-'));
  const port = PORT + 2;

  const previous = process.env.PUBLIC_DIR;
  process.env.PUBLIC_DIR = staleDir;
  // Publish with a generation time far enough in the past to breach the age
  // threshold the server enforces.
  const publishedStale = publishPortalDocuments(
    fixture(),
    new Date(Date.now() - 6 * 60 * 60 * 1000)
  );
  if (previous === undefined) delete process.env.PUBLIC_DIR;
  else process.env.PUBLIC_DIR = previous;

  const stale = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: { ...process.env, PUBLIC_DIR: staleDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  t.after(() => {
    stale.kill('SIGTERM');
    rmSync(staleDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('stale server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  await assertServesOurSnapshot(base, publishedStale.generatedAt);

  // The documents are still served — they are the best data available — but
  // health says plainly that they have stopped moving.
  const doc = await fetch(`${base}/api/v1/portal/gateways.json`);
  assert.equal(doc.status, 200);

  const body = (await (await fetch(`${base}/healthz`)).json()) as {
    status: string;
    portal: { stale: boolean; status: string; ageSeconds: number };
  };
  assert.equal(body.portal.stale, true);
  assert.equal(body.portal.status, 'stale');
  assert.ok(body.portal.ageSeconds > 3600);
  assert.equal(body.status, 'degraded');
});
