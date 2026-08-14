/**
 * The shared observer rollup, and the secret scrubber.
 *
 * The rollup exists once so `observers.json`, the network document and the
 * HTML report cannot disagree about a gateway's severity. The scrubber is the
 * only thing standing between a provider token in `SOLANA_RPC_URL` and stdout,
 * the database, or a published document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countFindings,
  rankFindings,
  summarizeObservers,
  toGatewayObserverSummaries,
  worseSeverity,
} from '../src/observers/rollup.js';
import { buildEpochDocument, buildObserversDocument } from '../src/observers/documents.js';
import { safeHost, scrubSecrets } from '../src/utils/runtime.js';
import type { Finding } from '../src/observers/types.js';
import { SHARED_REPORT_OBSERVERS, epoch511Observations, epochSnapshot } from './helpers.js';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  kind: 'shared_report_tx',
  epochIndex: 511,
  observers: SHARED_REPORT_OBSERVERS.slice(0, 3),
  severity: 'high',
  confidence: 1,
  detectedAt: new Date(0).toISOString(),
  summary: 'test finding',
  detail: {},
  ...overrides,
});

test('observers are summarized once, from the epochs they actually appear in', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const findings = [
    finding(),
    finding({ id: 'f2', kind: 'near_identical_results', severity: 'medium', confidence: 0.5 }),
    finding({ id: 'f3', observers: ['nobody-we-captured'] }),
  ];

  const accumulators = summarizeObservers([epoch], findings);
  assert.equal(accumulators.size, 17, 'one row per observed observer, and no invented rows');

  const named = accumulators.get(SHARED_REPORT_OBSERVERS[0]);
  assert.equal(named?.findingCount, 2);
  assert.equal(named?.maxSeverity, 'high', 'the worst severity wins, not the last one');
  assert.deepEqual([...(named?.kinds ?? [])].sort(), [
    'near_identical_results',
    'shared_report_tx',
  ]);
  assert.equal(named?.sharedReportEpochs.size, 1, 'its report tx was submitted by others too');

  const independent = accumulators.get('independent-0');
  assert.equal(independent?.findingCount, 0);
  assert.equal(independent?.maxSeverity, null);
  assert.equal(independent?.sharedReportEpochs.size, 0);

  const summaries = toGatewayObserverSummaries(accumulators);
  assert.equal(summaries.get(SHARED_REPORT_OBSERVERS[0])?.epochsObserved, 1);
  assert.equal(summaries.get(SHARED_REPORT_OBSERVERS[0])?.firstEpochIndex, 511);
});

test('the observers document and the rollup agree, because they share one implementation', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const findings = [finding()];

  const document = buildObserversDocument([epoch], findings, new Map());
  const accumulators = summarizeObservers([epoch], findings);

  assert.equal(document.observerCount, accumulators.size);
  for (const entry of document.observers) {
    const source = accumulators.get(entry.observer);
    assert.equal(entry.findingCount, source?.findingCount);
    assert.equal(entry.maxSeverity, source?.maxSeverity ?? null);
    assert.equal(entry.distinctReportTxIds, source?.reportTxIds.size);
  }
});

test('ranking is worst-first, then confidence, then newest epoch', () => {
  const ranked = rankFindings([
    finding({ id: 'low', severity: 'low', confidence: 1 }),
    finding({ id: 'high-weak', severity: 'high', confidence: 0.2 }),
    finding({ id: 'high-strong', severity: 'high', confidence: 0.9 }),
    finding({ id: 'cross-epoch', severity: 'high', confidence: 0.9, epochIndex: null }),
  ]);

  assert.deepEqual(
    ranked.map((f) => f.id),
    ['cross-epoch', 'high-strong', 'high-weak', 'low']
  );
});

test('counts cover every severity bucket even when empty', () => {
  const { bySeverity, byKind } = countFindings([
    finding(),
    finding({ id: 'f2', kind: 'shared_ip', severity: 'medium' }),
  ]);

  assert.deepEqual(bySeverity, { info: 0, low: 0, medium: 1, high: 1 });
  assert.deepEqual(byKind, { shared_report_tx: 1, shared_ip: 1 });
  assert.equal(worseSeverity(null, 'info'), 'info');
  assert.equal(worseSeverity('high', 'low'), 'high');
  assert.equal(worseSeverity('low', 'medium'), 'medium');
});

test('an epoch document publishes the blob verbatim and says how much of it counts', () => {
  const epoch = epochSnapshot(epoch511Observations());
  const document = buildEpochDocument(epoch, [finding()]);

  assert.equal(document.observationCount, 17);
  assert.equal(document.distinctReportTxIds, 11);
  assert.equal(document.registryCaptured, false, 'no snapshot => not decodable');
  assert.equal(document.registryApproximate, false);
  assert.equal(document.findings.length, 1);

  const observation = document.observations[0];
  assert.equal(Buffer.from(observation.gatewayResultsBase64, 'base64').length, 375);
  assert.equal(observation.gatewayResultsMeaningfulBytes, 81);
  assert.equal(observation.gatewayCount, 643);
  assert.ok(observation.gatewayResultsEncoding, 'consumers must be told not to guess');
});

test('scrubSecrets removes URLs and long tokens from anything logged or stored', () => {
  const url = 'https://mainnet.helius-rpc.com/?api-key=0123456789abcdef0123456789abcdef';

  assert.equal(scrubSecrets(`connect ECONNREFUSED ${url}`), 'connect ECONNREFUSED <redacted-url>');
  assert.doesNotMatch(scrubSecrets(new Error(`Failed to parse URL from ${url}`)), /helius|api-key/);
  // A schemeless paste — the commonest provider-onboarding mistake — is caught
  // by the long-token rule instead.
  assert.doesNotMatch(
    scrubSecrets(
      'Failed to parse URL from mainnet.helius-rpc.com/?api-key=0123456789abcdef0123456789abcdef'
    ),
    /0123456789abcdef0123456789abcdef/
  );
  assert.equal(scrubSecrets('plain failure'), 'plain failure');
  assert.ok(scrubSecrets('x'.repeat(5000)).length <= 1000, 'bounded, so a log cannot be flooded');
});

test('safeHost never returns a path or a query string', () => {
  assert.equal(
    safeHost('https://rpc.example.com:8899/path?api-key=secret'),
    'rpc.example.com:8899'
  );
  assert.equal(safeHost('ht!tp://rpc.example.com/?api-key=secret'), '<redacted>');
  assert.equal(safeHost(''), '<redacted>');
});
