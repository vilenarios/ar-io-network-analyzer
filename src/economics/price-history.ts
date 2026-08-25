/**
 * Load the checked-in ARIO daily close prices into `ario_price_daily`.
 *
 * The history is a file rather than an API call because the alignment between
 * CoinGecko's query date and the day a price actually closed had to be verified
 * by hand — see the header of `data/ario-price-daily.csv`. Freezing the
 * verified series into the repo makes that reviewable in a diff and keeps a
 * one-shot recovery from depending on a third party being up.
 *
 * Idempotent: `INSERT OR IGNORE` on the date key, so re-running loads nothing.
 * Prices already stored are never revised — a historical close does not change,
 * and if the source ever disagrees that is a fact worth noticing, not silently
 * overwriting.
 */

import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const PRICE_HISTORY_SOURCE = 'coingecko:ar-io-network:daily-close';

/** Repo-root `data/ario-price-daily.csv`, resolved relative to this module. */
export function defaultPriceHistoryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../data/ario-price-daily.csv');
}

export interface DailyPrice {
  closeDate: string;
  priceUsd: number;
}

/** Parse the CSV. Comment and header lines are skipped; malformed rows throw. */
export function parsePriceHistory(csv: string): DailyPrice[] {
  const out: DailyPrice[] = [];
  for (const raw of csv.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('close_date')) continue;

    const [closeDate, price] = line.split(',');
    const priceUsd = Number(price);
    // Loud rather than lenient: a row silently dropped here becomes a null
    // price on an epoch, which reads as "no data" instead of "bad file".
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate ?? '')) {
      throw new Error(`price history: bad date in line "${line}"`);
    }
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`price history: bad price in line "${line}"`);
    }
    out.push({ closeDate, priceUsd });
  }
  return out;
}

export function loadPriceHistory(
  db: Database,
  options: { path?: string; now?: number; dryRun?: boolean } = {}
): { loaded: number; alreadyPresent: number; prices: DailyPrice[] } {
  const path = options.path ?? defaultPriceHistoryPath();
  if (!existsSync(path)) throw new Error(`price history not found at ${path}`);

  const prices = parsePriceHistory(readFileSync(path, 'utf8'));
  const now = options.now ?? Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ario_price_daily (close_date, price_usd, source, loaded_at)
     VALUES (?, ?, ?, ?)`
  );

  let loaded = 0;
  db.transaction(() => {
    for (const { closeDate, priceUsd } of prices) {
      if (options.dryRun) {
        if (priceForCloseDate(db, closeDate) === null) loaded++;
        continue;
      }
      if (insert.run(closeDate, priceUsd, PRICE_HISTORY_SOURCE, now).changes > 0) loaded++;
    }
  })();

  return { loaded, alreadyPresent: prices.length - loaded, prices };
}

/** Look up a stored close price. Null when the day is not covered. */
export function priceForCloseDate(db: Database, closeDate: string): number | null {
  const row = db
    .prepare<[string], { price_usd: number }>(
      'SELECT price_usd FROM ario_price_daily WHERE close_date = ?'
    )
    .get(closeDate);
  return row ? row.price_usd : null;
}
