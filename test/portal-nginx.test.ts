/**
 * The production path: nginx serving the documents off disk.
 *
 * `portal-e2e.test.ts` spawns the Node server, which in production only ever
 * answers `/healthz` — nginx serves everything under `/api/v1/` via `try_files`
 * and never proxies it. So the assertions there describe a supported fallback,
 * not what users receive. This file covers the real thing.
 *
 * It needs a running nginx with published documents behind it, which CI does
 * not have, so it is **opt-in**:
 *
 *   PORTAL_NGINX_BASE=https://network.services.ar.io yarn test
 *
 * Without that variable every test here is skipped rather than failed — a
 * silent pass would be worse than an honest skip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.PORTAL_NGINX_BASE?.replace(/\/+$/, '');
const skip = BASE ? false : 'set PORTAL_NGINX_BASE to run (needs a live nginx)';

const doc = (name: string) => `${BASE}/api/v1/portal/${name}.json`;

test('nginx serves documents off disk, not by proxying Node', { skip }, async () => {
  const res = await fetch(doc('gateways'));
  assert.equal(res.status, 200);

  const etag = res.headers.get('etag');
  assert.ok(etag, 'nginx must send an ETag');

  // nginx's validator is "<hex-mtime>-<hex-size>". The Node fallback would send
  // the 64-char sha256 instead, so this also proves nothing is proxying.
  assert.match(
    etag,
    /^"[0-9a-f]+-[0-9a-f]+"$/,
    `expected an nginx mtime-size ETag, got ${etag} — if this is 64 hex chars, ` +
      `requests are reaching Node and try_files is not doing its job`
  );
});

test('the manifest digest is NOT a usable cache validator in production', { skip }, async () => {
  const manifest = (await (await fetch(doc('index'))).json()) as {
    documents: Record<string, { sha256: string }>;
  };
  const sha256 = manifest.documents.gateways.sha256;

  // The property the design is built around holds only on the Node fallback.
  // Documented in docs/portal-api.md §9: ETags are opaque, echo what you got.
  const withDigest = await fetch(doc('gateways'), {
    headers: { 'If-None-Match': `"${sha256}"` },
  });
  assert.equal(
    withDigest.status,
    200,
    'the manifest sha256 must NOT satisfy nginx — if this ever returns 304, ' +
      'the consumer contract should be updated to promise digest-as-ETag'
  );

  // Echoing back what the response gave you does work, on either path.
  const first = await fetch(doc('gateways'));
  const echoed = await fetch(doc('gateways'), {
    headers: { 'If-None-Match': first.headers.get('etag') ?? '' },
  });
  assert.equal(echoed.status, 304, 'echoing the served ETag must revalidate');
});

test('precompressed bytes are served, not compressed per request', { skip }, async () => {
  const res = await fetch(doc('gateways'), { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  // gzip_static reads the .gz sibling the publisher wrote; on-the-fly gzip is off.
  assert.ok(res.headers.get('vary')?.toLowerCase().includes('accept-encoding'));
});

test('every document carries the same header set, manifest included', { skip }, async () => {
  // `add_header` does not inherit into nested locations, so the manifest's
  // own location block has to repeat them. Dropping one there is invisible
  // until a browser rejects the manifest but accepts every other document.
  const keys = [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'x-content-type-options',
    'referrer-policy',
    'vary',
  ];
  const [document, manifest] = await Promise.all([fetch(doc('gateways')), fetch(doc('index'))]);

  for (const k of keys) {
    assert.equal(
      manifest.headers.get(k),
      document.headers.get(k),
      `manifest and documents disagree on ${k}`
    );
  }

  // Cache-Control is the one that is meant to differ: the manifest is the
  // polling target and must go stale before the documents it describes.
  assert.match(document.headers.get('cache-control') ?? '', /max-age=60/);
  assert.match(manifest.headers.get('cache-control') ?? '', /max-age=30/);
});

test('an unpublished document is a 404, not a directory listing', { skip }, async () => {
  assert.equal((await fetch(doc('nope'))).status, 404);
  assert.equal((await fetch(`${BASE}/`)).status, 404);
});
