/**
 * Cluster id prefixes.
 *
 * `analyzer.ts` mints ids as `domain-<n>` / `ip-exact-<n>`, where `<n>` is a
 * per-run sequence, and `publish/contract.ts` maps them back onto the stable
 * keys (`domain:<base>` / `ip-exact:<ip>`) that make `network.json` and
 * `gateways.json` joinable. The producer and the consumer therefore have to
 * agree on the prefix — and a rename on one side alone would silently
 * reclassify every exact-IP cluster as a domain cluster, with both documents
 * still validating.
 *
 * They live in their own module rather than in `analyzer.ts` so the publish
 * layer can import them without dragging in the analyzer's DNS and geo stack.
 */

export const DOMAIN_CLUSTER_PREFIX = 'domain';
export const IP_EXACT_CLUSTER_PREFIX = 'ip-exact';
