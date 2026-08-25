/**
 * ARIO spot price, for denominating the economics series in USD.
 *
 * This is the only off-chain input in the whole publish pipeline, and it is
 * treated accordingly: fetched at most once per epoch sample, always optional,
 * and carrying its provenance so a consumer can decide whether to trust it
 * rather than inheriting our confidence.
 *
 * WHY NOT POLL HOURLY. The series is one row per epoch — daily — so hourly
 * polling would discard 23 samples out of 24. CoinGecko's keyless tier
 * advertises `x-ratelimit-limit: 2` per window, and this host shares one public
 * IP with six other services, so a chatty poller here becomes someone else's
 * 429. One call per epoch sits far inside any plausible limit.
 *
 * WHAT THIS CANNOT DO. The keyless tier has no usable historical endpoint, so a
 * price missed today cannot be recovered tomorrow. That is accepted: a gap in
 * `arioPriceUsd` is honest, and the consumer can still render the ARIO figure.
 * If per-day price history ever becomes a requirement — denominating historical
 * ArNS registrations, say — it needs its own forward-only capture table,
 * because it can never be backfilled.
 */

const COINGECKO_ID = 'ar-io-network';
const PRICE_URL =
  `https://api.coingecko.com/api/v3/simple/price` +
  `?ids=${COINGECKO_ID}&vs_currencies=usd&include_last_updated_at=true`;

/** Keep it short: a slow price must not hold up publishing on-chain data. */
const TIMEOUT_MS = 8_000;

export interface ArioPrice {
  usd: number;
  /** Opaque provenance string, published verbatim. */
  source: string;
  /** When the SOURCE observed the price, unix ms — not when we fetched it. */
  observedAt: number;
}

/**
 * Fetch the spot price, or null.
 *
 * Never throws and never retries. The caller writes its row either way: losing
 * a third-party price is a cosmetic gap, losing the on-chain sample is
 * permanent, and the two must not share a failure mode.
 */
export async function fetchArioPriceUsd(
  fetchImpl: typeof fetch = fetch
): Promise<ArioPrice | null> {
  try {
    const response = await fetchImpl(PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as Record<
      string,
      { usd?: unknown; last_updated_at?: unknown } | undefined
    >;
    const entry = body?.[COINGECKO_ID];
    const usd = entry?.usd;

    // A zero or negative price is a bad read, not a cheap token.
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;

    const updatedAt = entry?.last_updated_at;
    const observedAt =
      typeof updatedAt === 'number' && Number.isFinite(updatedAt)
        ? updatedAt * 1000
        : Date.now();

    return { usd, source: `coingecko:${COINGECKO_ID}`, observedAt };
  } catch {
    // Offline, DNS, timeout, rate limit, malformed body — all the same answer.
    return null;
  }
}
