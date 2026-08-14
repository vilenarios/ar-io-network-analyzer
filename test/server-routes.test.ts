/**
 * The server's routing and containment rules.
 *
 * The server has no business logic, so these two functions ARE its security
 * surface: `routeToFile` decides what is addressable and `resolveWithin`
 * decides what may be read. Both are pure, so neither test binds a port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { routeToFile } from '../src/server/index.js';
import { ARCHIVE_FILE_PATTERN, cacheControlFor, resolveWithin } from '../src/server/static.js';

test('the published documents are the only addressable API routes', () => {
  assert.equal(routeToFile('/'), 'index.html');
  assert.equal(routeToFile('/index.html'), 'index.html');
  assert.equal(routeToFile('/api/v1/index.json'), 'api/v1/index.json');
  assert.equal(routeToFile('/api/v1/network.json'), 'api/v1/network.json');
  assert.equal(routeToFile('/api/v1/gateways.json'), 'api/v1/gateways.json');
  assert.equal(routeToFile('/api/v1/observers.json'), 'api/v1/observers.json');
  assert.equal(routeToFile('/api/v1/findings.json'), 'api/v1/findings.json');
  assert.equal(routeToFile('/api/v1/epochs/511.json'), 'api/v1/epochs/511.json');

  assert.equal(routeToFile('/api/v1/secrets.json'), null);
  assert.equal(routeToFile('/api/v1/epochs/abc.json'), null, 'the epoch segment is digits only');
  assert.equal(routeToFile('/api/v1/epochs/../index.json'), null);
  assert.equal(routeToFile('/package.json'), null);
  assert.equal(routeToFile('/healthz.json'), null);
});

test('archive routes are limited to the three files the publisher writes', () => {
  assert.equal(routeToFile('/archive/2026-08-13/'), 'archive/2026-08-13/index.html');
  assert.equal(routeToFile('/archive/2026-08-13/gateways.csv'), 'archive/2026-08-13/gateways.csv');
  assert.equal(routeToFile('/archive/2026-08-13/summary.json'), 'archive/2026-08-13/summary.json');

  assert.equal(routeToFile('/archive/not-a-date/index.html'), null);
  assert.equal(routeToFile('/archive/2026-08-13/private.key'), null);
  assert.equal(routeToFile('/archive/2026-08-13/nested/index.html'), null);

  assert.equal(ARCHIVE_FILE_PATTERN.test('index.html'), true);
  assert.equal(ARCHIVE_FILE_PATTERN.test('../../etc/passwd'), false);
});

test('resolveWithin refuses to escape the public root', () => {
  const root = mkdtempSync(join(tmpdir(), 'analyzer-root-'));
  try {
    writeFileSync(join(root, 'index.html'), 'ok');

    assert.equal(resolveWithin(root, 'index.html'), resolve(root, 'index.html'));
    assert.equal(resolveWithin(root, '/index.html'), resolve(root, 'index.html'));

    assert.equal(resolveWithin(root, '../../../../etc/passwd'), null);
    assert.equal(resolveWithin(root, '..'), null);
    assert.equal(resolveWithin(root, 'a/../../outside'), null);
    assert.equal(resolveWithin(root, 'index.html\0.png'), null, 'NUL truncation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWithin refuses a symlink that points out of the root', () => {
  const base = mkdtempSync(join(tmpdir(), 'analyzer-link-'));
  const root = join(base, 'public');
  try {
    mkdirSync(root);
    writeFileSync(join(base, 'secret.txt'), 'not for the internet');
    symlinkSync(join(base, 'secret.txt'), join(root, 'escape.txt'));

    // Lexically this is inside the root; only a realpath check catches it.
    assert.equal(resolveWithin(root, 'escape.txt'), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache lifetimes match how often each document changes', () => {
  assert.equal(cacheControlFor('/api/v1/index.json'), 'public, max-age=30');
  assert.equal(cacheControlFor('/api/v1/epochs/511.json'), 'public, max-age=300');
  assert.equal(cacheControlFor('/api/v1/network.json'), 'public, max-age=60');
  assert.match(cacheControlFor('/archive/2026-08-13/index.html'), /immutable/);
});
