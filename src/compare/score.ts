/**
 * Ranks products by user fit and value.
 *
 * Deliberately NOT an input: affiliate status, commission, or anything about
 * how Choovio might be paid. `scoreProduct` never reads `product.affiliate`.
 */
import type { Dimensions, Offer, ProductRecord, ScoredProduct, ShoppingRequest } from "../types.js";
import { toBase, type FxRates } from "../research/fx.js";
import { canonicalSpecName } from "./merge.js";

const UNAVAILABLE = new Set(["out_of_stock", "discontinued"]);

export function offerTotal(o: Offer): number | null {
  if (!o.price) return null;
  return o.price.amount + (o.shipping && o.shipping.currency === o.price.currency ? o.shipping.amount : 0);
}

/** Offer total in the budget currency: as-is when currencies match, else converted when a rate is known. */
export function comparableTotal(o: Offer, req: ShoppingRequest, fx?: FxRates | null): number | null {
  const total = offerTotal(o);
  if (total === null || !o.price) return null;
  if (!req.currency || o.price.currency === req.currency) return total;
  return fx?.base === req.currency ? toBase(total, o.price.currency, fx) : null;
}

export function pickBestOffer(product: ProductRecord, req: ShoppingRequest, fx?: FxRates | null): Offer | null {
  const usable = product.offers.filter((o) => !UNAVAILABLE.has(o.availability) && o.shipsToCountry !== false);
  const pool = usable.length ? usable : product.offers;
  const sameCurrency = pool.filter((o) => o.price && (!req.currency || o.price.currency === req.currency));
  const convertible = pool.filter((o) => comparableTotal(o, req, fx) !== null);
  const candidates = sameCurrency.length ? sameCurrency : convertible.length ? convertible : pool;
  return [...candidates].sort((a, b) => (comparableTotal(a, req, fx) ?? offerTotal(a) ?? Infinity) - (comparableTotal(b, req, fx) ?? offerTotal(b) ?? Infinity))[0] ?? null;
}

function textOf(p: ProductRecord): string {
  return [p.name, p.brand, p.variant, ...p.specs.map((s) => `${s.name} ${s.value}`), ...p.reviews.map((r) => r.summary)].join(" ").toLowerCase();
}

const PREF_SYNONYMS: Record<string, string[]> = {
  "comfortable": ["comfort", "memory foam", "lightweight", "cushion", "padded", "plush"],
  "long work calls": ["microphone", "mic", "battery", "comfort", "noise", "multipoint", "call"],
  "noise cancelling": ["anc", "active noise", "noise cancel"],
  "quiet": ["db", "quiet", "silent", "low noise"],
  "wireless": ["bluetooth", "wireless", "cordless"],
  "lightweight": ["weight", "lightweight", "light"],
  "pet hair": ["pet", "hair", "tangle"],
  "long battery": ["battery", "hours", "runtime"],
  "battery life": ["battery", "hours", "runtime"],
  "energy efficient": ["energy", "kwh", "a+++", "energy rating"],
};

function prefMatches(pref: string, haystack: string): boolean {
  const p = pref.toLowerCase();
  if (haystack.includes(p)) return true;
  const syn = PREF_SYNONYMS[p] ?? p.split(/\s+/).filter((w) => w.length > 3);
  return syn.some((w) => haystack.includes(w));
}

/** Parse a product dimension spec into cm. Returns undefined when not stated. */
export function productDimensions(p: ProductRecord): Dimensions {
  const d: Dimensions = {};
  const toCm = (v: string): number | undefined => {
    const m = /(\d+(?:[.,]\d+)?)\s*(mm|cm|in|"|m)?\b/i.exec(v);
    if (!m) return undefined;
    const n = Number(m[1]!.replace(",", "."));
    const unit = (m[2] ?? "cm").toLowerCase();
    return unit === "mm" ? n / 10 : unit === "in" || unit === '"' ? n * 2.54 : unit === "m" ? n * 100 : n;
  };
  for (const s of p.specs) {
    const key = canonicalSpecName(s.name);
    if (key === "width" && d.widthCm === undefined) d.widthCm = toCm(s.value);
    if (key === "depth" && d.depthCm === undefined) d.depthCm = toCm(s.value);
    if (key === "height" && d.heightCm === undefined) d.heightCm = toCm(s.value);
    if (key === "dimensions" && d.widthCm === undefined) {
      const m = /(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|in)?/i.exec(s.value);
      if (m) {
        const unit = m[4] ?? "cm";
        d.widthCm = toCm(`${m[1]} ${unit}`);
        d.depthCm = toCm(`${m[2]} ${unit}`);
        d.heightCm = toCm(`${m[3]} ${unit}`);
      }
    }
  }
  return d;
}

export function fmtMoney(m: { amount: number; currency: string } | null): string {
  if (!m) return "not stated";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: m.currency }).format(m.amount);
  } catch {
    return `${m.amount.toFixed(2)} ${m.currency}`;
  }
}

export function scoreProduct(product: ProductRecord, req: ShoppingRequest, fx?: FxRates | null): ScoredProduct {
  const reasons: string[] = [];
  const concerns: string[] = [];
  let score = 50;
  let eligible = true;
  let ineligibleReason: string | undefined;
  const block = (why: string) => {
    if (eligible) {
      eligible = false;
      ineligibleReason = why;
    }
  };

  const offer = pickBestOffer(product, req, fx);
  const total = offer ? offerTotal(offer) : null;
  // The total in the budget currency; differs from `total` only when converted.
  const budgetTotal = offer ? comparableTotal(offer, req, fx) : null;
  const converted = Boolean(offer?.price && req.currency && offer.price.currency !== req.currency && budgetTotal !== null);

  // Availability
  if (!product.offers.length) {
    concerns.push("No offer found — price and stock unknown");
    block("No verified price or stock information");
  } else if (product.offers.every((o) => UNAVAILABLE.has(o.availability))) {
    concerns.push("Not currently available from the sources checked");
    block("Not currently available");
    score -= 30;
  } else if (offer?.availability === "in_stock") {
    reasons.push(offer.variant ? `In stock at the time checked (${offer.variant})` : "In stock at the time checked");
    const soldOut = product.offers.filter((o) => UNAVAILABLE.has(o.availability) && o.variant);
    if (soldOut.length) concerns.push(`Some variants are sold out (${soldOut.slice(0, 4).map((o) => o.variant).join(", ")}${soldOut.length > 4 ? "…" : ""}) — check yours is available`);
  } else if (offer?.availability === "limited") {
    concerns.push("Limited stock");
    score -= 3;
  } else if (offer?.availability === "preorder") {
    concerns.push("Pre-order / backorder — it won't ship right away");
    score -= 6;
  } else {
    concerns.push("Stock status not stated");
    score -= 4;
  }
  if (req.country && product.offers.length && product.offers.every((o) => o.shipsToCountry === false)) {
    concerns.push(`The seller does not list delivery to ${req.country}`);
    block(`Not delivered to ${req.country}`);
  }

  // Price & budget
  let withinBudget: boolean | null = null;
  if (!offer?.price) {
    concerns.push("Price could not be verified");
    block("Price could not be verified");
    score -= 12;
  } else if (req.currency && offer.price.currency !== req.currency && budgetTotal === null) {
    concerns.push(`Priced in ${offer.price.currency}, not ${req.currency} — no exchange rate available, so the budget can't be confirmed`);
    block("Price is in a different currency");
  } else if (req.budget && total !== null && budgetTotal !== null) {
    const budgetCurrency = req.currency ?? offer.price.currency;
    const shown = converted
      ? `${fmtMoney({ amount: total, currency: offer.price.currency })} (≈ ${fmtMoney({ amount: budgetTotal, currency: budgetCurrency })})`
      : fmtMoney({ amount: total, currency: offer.price.currency });
    withinBudget = budgetTotal <= req.budget.max;
    if (!withinBudget) {
      concerns.push(`Over budget: ${shown} vs your ${fmtMoney({ amount: req.budget.max, currency: budgetCurrency })} limit`);
      block("Over budget");
      score -= 25;
    } else {
      const headroom = 1 - budgetTotal / req.budget.max;
      score += Math.round(headroom * 10);
      reasons.push(`Within budget at ${shown}${offer.shipping ? " including stated shipping" : ""}`);
      if (req.budget.min !== undefined && budgetTotal < req.budget.min) concerns.push("Below the price range you mentioned — check it isn't a lesser variant");
    }
    if (converted && fx) {
      concerns.push(`Converted from ${offer.price.currency} at the ${fx.date} ${fx.source.replace(/ rates$/, "")} rate — your bank's rate and fees may differ`);
      if (withinBudget && budgetTotal > req.budget.max * 0.95) concerns.push("Close to your limit after conversion — a small rate change could put it over");
    }
  }

  // Discount claims are marketing until proven; we report them but don't reward them.
  if (offer?.listPrice && offer.price && offer.listPrice.amount > offer.price.amount) {
    const pct = Math.round((1 - offer.price.amount / offer.listPrice.amount) * 100);
    concerns.push(`Seller claims ${pct}% off a "was" price of ${fmtMoney(offer.listPrice)} — price history not verified`);
  }

  // Preferences and must-haves
  const hay = textOf(product);
  let prefPoints = 0;
  for (const pref of req.preferences) {
    if (prefMatches(pref, hay)) {
      prefPoints += 8;
      reasons.push(`Matches "${pref}" based on listed specs`);
    }
  }
  score += Math.min(prefPoints, 32);
  for (const must of req.mustHave) {
    if (prefMatches(must, hay)) {
      score += 5;
      reasons.push(`Has ${must}`);
    } else {
      score -= 15;
      concerns.push(`Couldn't confirm it has ${must}`);
    }
  }

  // Fit check
  if (req.space) {
    const dims = productDimensions(product);
    const checks: [keyof Dimensions, string][] = [["widthCm", "width"], ["depthCm", "depth"], ["heightCm", "height"]];
    for (const [k, label] of checks) {
      const need = req.space[k];
      if (need === undefined) continue;
      const have = dims[k];
      if (have === undefined) {
        concerns.push(`Product ${label} not stated — can't confirm fit`);
        block("Fit could not be confirmed");
      } else if (have > need) {
        concerns.push(`Too ${label === "height" ? "tall" : label === "width" ? "wide" : "deep"}: ${have.toFixed(1)} cm vs ${need.toFixed(1)} cm space`);
        block("Will not fit the stated space");
      } else {
        const spare = need - have;
        reasons.push(`Fits ${label} with ${spare.toFixed(1)} cm to spare`);
        if (spare < 2) concerns.push(`Very tight on ${label} (${spare.toFixed(1)} cm spare) — allow for hoses, doors and ventilation`);
      }
    }
  }

  // Review evidence
  const independent = product.reviews.filter((r) => r.kind === "independent_review" || r.kind === "search_snippet");
  const hosted = product.reviews.find((r) => r.kind === "retailer_rating" && r.rating);
  if (hosted?.rating) {
    const norm = hosted.rating.value / hosted.rating.best;
    const confidence = Math.min(1, (hosted.rating.count ?? 10) / 100);
    score += Math.round((norm - 0.7) * 40 * confidence);
    if (norm >= 0.85 && (hosted.rating.count ?? 0) >= 50) reasons.push(`Well rated by buyers (${hosted.summary})`);
    if (norm < 0.7) concerns.push(`Mixed buyer ratings (${hosted.summary})`);
  }
  if (independent.length) {
    score += 4;
    reasons.push(`Covered by ${independent.length} independent review source${independent.length > 1 ? "s" : ""}`);
  }
  for (const c of product.complaints) {
    score -= 5;
    concerns.push(`Recurring complaint: ${c.text}`);
  }

  // Data quality
  score -= Math.min(product.unknowns.length * 3, 15);
  for (const c of product.conflicts) {
    score -= 4;
    concerns.push(`Sources disagree on ${c.spec}: ${c.values.map((v) => v.value).join(" vs ")}`);
  }
  if (product.warnings.some((w) => /instruct AI/i.test(w))) {
    score -= 10;
    concerns.push("Listing contains hidden instructions aimed at AI shopping assistants — treat its claims with extra caution");
  }

  return {
    product,
    bestOffer: offer,
    score: Math.max(0, Math.min(100, Math.round(score))),
    fit: { reasons: [...new Set(reasons)], concerns: [...new Set(concerns)] },
    withinBudget,
    eligible,
    ineligibleReason,
  };
}

/** Stable ranking: eligible first, then score, then lower known total, then name. */
export function rankProducts(products: ProductRecord[], req: ShoppingRequest, fx?: FxRates | null): ScoredProduct[] {
  return products
    .map((p) => scoreProduct(p, req, fx))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      const ta = a.bestOffer ? comparableTotal(a.bestOffer, req, fx) ?? offerTotal(a.bestOffer) ?? Infinity : Infinity;
      const tb = b.bestOffer ? comparableTotal(b.bestOffer, req, fx) ?? offerTotal(b.bestOffer) ?? Infinity : Infinity;
      if (ta !== tb) return ta - tb;
      return a.product.name.localeCompare(b.product.name);
    });
}
