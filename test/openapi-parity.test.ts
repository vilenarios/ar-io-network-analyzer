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
  '/api/v1/index.json',
  '/api/v1/findings.json',
  '/api/v1/observers.json',
  '/api/v1/epochs/{epochIndex}.json',
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
