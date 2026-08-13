/**
 * The report is now SERVED over HTTP, on the same origin as the API — so an
 * injection in it is stored XSS, not a local-file curiosity.
 *
 * Two of the fields it renders are attacker-influenced: `isp` / `org` / `city`
 * come from a plaintext-HTTP geo lookup (anyone on-path chooses them), and
 * `fqdn` comes from on-chain gateway settings (anyone who can register a
 * gateway chooses that). Both must survive rendering as text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateHTMLReport } from '../src/utils/html-generator.js';
import type { CentralizationReport, GatewayAnalysis } from '../src/types.js';

const PAYLOAD = '</script><img src=x onerror=alert(document.domain)>';

function gateway(overrides: Partial<GatewayAnalysis> = {}): GatewayAnalysis {
  return {
    fqdn: 'gateway.example.com',
    wallet: 'WALLET1234567890',
    stake: 10_000,
    status: 'joined',
    baseDomain: 'example.com',
    domainPattern: 'none',
    domainGroupSize: 1,
    domainAge: 100,
    ipAddress: '192.0.2.1',
    ipRange: '192.0.2',
    asn: 'AS1',
    isp: 'Example ISP',
    org: 'Example Org',
    city: 'Somewhere',
    country: 'Nowhere',
    domainScore: 0,
    ipScore: 0,
    temporalScore: 0,
    stakeScore: 0,
    overallCentralization: 0,
    clusterId: null,
    ...overrides,
  } as GatewayAnalysis;
}

function summary(gateways: GatewayAnalysis[]): CentralizationReport {
  return {
    timestamp: new Date(0).toISOString(),
    totalGateways: gateways.length,
    totalGatewaysInNetwork: gateways.length,
    totalResolved: gateways.length,
    totalFailedDns: 0,
    clusteredGateways: 0,
    highCentralization: 0,
    clusters: [],
    // The report's "most suspicious" table renders the fqdn directly, so the
    // hostile value has to reach it for this test to mean anything.
    topSuspicious: gateways.map((gateway) => ({
      fqdn: gateway.fqdn,
      score: gateway.overallCentralization,
      reasons: ['fixture'],
    })),
  };
}

test('a hostile geo field cannot break out of the embedded script payload', () => {
  const rows = [gateway({ isp: PAYLOAD, org: PAYLOAD, city: PAYLOAD })];
  const html = generateHTMLReport(summary(rows), rows, 'a.csv', 'b.json');

  // The payload survives as TEXT — that is correct, it is data — but it must
  // never survive as MARKUP. No `<` from it means no tag can ever form, and in
  // particular no early `</script>`.
  assert.equal(html.includes('<img src=x'), false, 'no tag may form from data');
  assert.equal(html.includes(`"isp":"${PAYLOAD}`), false, 'raw payload must not survive');
  assert.ok(html.includes('&lt;/script&gt;&lt;img'), 'escaped, not silently dropped');

  // Every `</script>` in the document belongs to a real `<script>` element.
  const opens = (html.match(/<script[\s>]/g) ?? []).length;
  const closes = (html.match(/<\/script>/g) ?? []).length;
  assert.equal(opens, closes, 'a data-injected close tag would unbalance these');
});

test('a hostile fqdn is escaped in the table body', () => {
  const rows = [gateway({ fqdn: `evil.example.com<img src=x onerror=alert(1)>` })];
  const html = generateHTMLReport(summary(rows), rows, 'a.csv', 'b.json');

  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('ordinary values are still rendered readably', () => {
  const rows = [gateway({ fqdn: 'permagate.io', isp: 'Cloudflare, Inc.' })];
  const html = generateHTMLReport(summary(rows), rows, 'a.csv', 'b.json');

  assert.ok(html.includes('permagate.io'));
  assert.ok(html.includes('Cloudflare, Inc.'));
});
