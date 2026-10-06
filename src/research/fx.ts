/**
 * Exchange rates for budget checks only. Prices are always shown in the seller's
 * currency; a converted figure is labelled approximate. Rates are the European
 * Central Bank's daily reference rates via Frankfurter (free, no key).
 */

export interface FxRates {
  /** The budget currency. */
  base: string;
  /** Units of each currency per 1 `base`. */
  rates: Record<string, number>;
  /** Date the rates were published (YYYY-MM-DD). */
  date: string;
  source: string;
}

export type FxSource = (base: string) => Promise<FxRates | null>;

/** Convert `amount` in `currency` to the rates' base currency, or null when no rate is known. */
export function toBase(amount: number, currency: string, fx: FxRates | null | undefined): number | null {
  if (!fx) return null;
  if (currency === fx.base) return amount;
  const rate = fx.rates[currency];
  return rate && rate > 0 ? amount / rate : null;
}

const CACHE_MS = 12 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; rates: FxRates }>();

/** Live ECB rates, cached per base currency. Returns null (never throws) when unavailable. */
export const liveFx: FxSource = async (base) => {
  const key = base.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rates;
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
    if (data.base !== key || !data.rates || !data.date) return null;
    const rates: FxRates = { base: key, rates: data.rates, date: data.date, source: "European Central Bank reference rates" };
    cache.set(key, { at: Date.now(), rates });
    return rates;
  } catch {
    return null;
  }
};
