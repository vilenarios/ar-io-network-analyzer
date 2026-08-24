/**
 * The spec must describe the routes the server actually serves.
 *
 * A spec that has drifted from the implementation is worse than no spec: a
 * consumer builds against it, and the failure surfaces in their code rather
 * than ours. There is no YAML dependency in this project, so the path keys are
 * extracted with a regex — paths sit at two-space indent under `paths:`, which
 * is stable enough for a drift guard even though it is not a parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_DOCUMENTS, portalDocumentPath } from '../src/portal/contract.js';
import { OBSERVER_DOCUMENTS } from '../src/publish/contract.js';
import { routeToFile } from '../src/server/index.js';

const SPEC = join(import.meta.dirname, '..', 'docs', 'openapi.yaml');

function specPaths(): string[] {
  const src = readFileSync(SPEC, 'utf8');
  const body = src.slice(src.indexOf('\npaths:'));
  const end = body.search(/\ncomponents:/);
  return [...(end === -1 ? body : body.slice(0, end)).matchAll(/^ {2}(\/\S*):$/gm)].map(
    (m) => m[1]
  );
}

/**
 * Routes the server can serve. `/healthz` is hardcoded in the request handler;
 * everything under /api/v1 is a published document. Kept as a literal list so
 * adding a route without describing it fails here.
 */
const SERVED = [
  // Derived from the contract so the router and the spec cannot drift apart.
  // network.json and gateways.json were served but listed in NEITHER the spec
  // nor this array, which a check that only compares the two lists to each
  // other can never catch.
  ...OBSERVER_DOCUMENTS.map((name: string) => `/api/v1/${name}.json`),
  '/api/v1/epochs/{epochIndex}.json',
  '/archive/{date}/{file}',
  '/',
  '/api/v1/portal/index.json',
  '/api/v1/portal/gateways.json',
  '/api/v1/portal/vaults.json',
  '/api/v1/portal/balances.json',
  '/api/v1/portal/delegates.json',
  '/api/v1/portal/withdrawals.json',
  '/api/v1/portal/primaryNames.json',
  '/api/v1/portal/arnsRecords.json',
  '/api/v1/portal/summary.json',
  '/healthz',
];

test('every documented path is one the server serves', () => {
  for (const path of specPaths()) {
    assert.ok(
      SERVED.includes(path),
      `openapi.yaml documents ${path}, which the server does not serve`
    );
  }
});

test('every served path is documented', () => {
  const documented = specPaths();
  for (const path of SERVED) {
    assert.ok(
      documented.includes(path),
      `the server serves ${path}, which openapi.yaml does not document`
    );
  }
});

test('the spec records the two properties a consumer would otherwise get wrong', () => {
  const src = readFileSync(SPEC, 'utf8');
  // Truncated pair lists and a windowed feed are both cases where a naive
  // consumer would silently read an excerpt as the whole set.
  assert.match(src, /pairsTruncated/, 'pair truncation must be documented');
  assert.match(src, /FindingsWindow/, 'feed windowing must be documented');
  assert.match(src, /calibrated/, 'the calibration caveat must be documented');
});

/**
 * The list above is maintained by hand, which is exactly how the two observer
 * documents (`network.json`, `gateways.json`) drifted: routable, undocumented,
 * and invisible to a literal-list check. For the portal namespace the contract
 * is the source of truth, so derive the expectation from it instead.
 */
test('every portal document in the contract is routable and documented', () => {
  const documented = specPaths();

  for (const name of [...PORTAL_DOCUMENTS, 'index'] as const) {
    const path = `/${portalDocumentPath(name)}`;

    assert.equal(
      routeToFile(path),
      portalDocumentPath(name),
      `${path} is in the contract but the server does not route it`
    );
    assert.ok(documented.includes(path), `${path} is in the contract but openapi.yaml omits it`);
  }
});

test('the portal namespace rejects names outside the contract', () => {
  // A loose `(.*)` here would turn the document namespace into a path probe.
  assert.equal(routeToFile('/api/v1/portal/secrets.json'), null);
  assert.equal(routeToFile('/api/v1/portal/../index.json'), null);
  assert.equal(routeToFile('/api/v1/portal/gateways.json.gz'), null);
});

test('the portal contract documents the freshness contract a consumer needs', () => {
  const src = readFileSync(SPEC, 'utf8');
  // A consumer that ignores staleness cannot tell a snapshot published a
  // minute ago from one that stopped updating hours ago.
  assert.match(src, /freshness\.stale/, 'staleness must be documented for consumers');
  assert.match(src, /consecutiveFailures/, 'failure counting must be documented');
  assert.match(src, /mARIO/, 'balance units must be documented');
});
