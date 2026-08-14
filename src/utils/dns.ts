/**
 * Parallel DNS resolution, extracted verbatim from the analyzer so other
 * cadences can reuse it without instantiating the analyzer.
 *
 * The `resolution_failed` / `unknown` sentinels are part of the CSV contract —
 * they are normalized to `null` only at the published-JSON boundary.
 */

import { resolve4 } from 'dns/promises';

export const DNS_FAILURE_SENTINEL = 'resolution_failed';
export const IP_RANGE_UNKNOWN_SENTINEL = 'unknown';

export interface DnsResolution {
  fqdn: string;
  ip: string;
  ipRange: string;
}

/**
 * Resolve every FQDN with a bounded concurrency, preserving input order.
 * Never rejects: a failed lookup yields the sentinel pair.
 */
export async function resolveGatewayIps(
  targets: Array<{ fqdn: string }>,
  concurrency = 50,
  onProgress?: (completed: number, total: number) => void
): Promise<DnsResolution[]> {
  const results: DnsResolution[] = [];
  let completed = 0;

  const resolveDns = async (target: { fqdn: string }): Promise<DnsResolution> => {
    try {
      const addresses = await resolve4(target.fqdn);
      const ip = addresses[0];
      const ipParts = ip.split('.');
      const ipRange = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;
      return { fqdn: target.fqdn, ip, ipRange };
    } catch {
      return {
        fqdn: target.fqdn,
        ip: DNS_FAILURE_SENTINEL,
        ipRange: IP_RANGE_UNKNOWN_SENTINEL,
      };
    }
  };

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(resolveDns));
    results.push(...batchResults);
    completed += batch.length;
    onProgress?.(completed, targets.length);
  }

  return results;
}
