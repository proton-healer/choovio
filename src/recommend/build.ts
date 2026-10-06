/**
 * Builds the final recommendation: best choice, two alternatives, comparison
 * table, cost breakdown, reasons to avoid, links, sources and uncertainties.
 */
import { config } from "../config.js";
import { cleanProductUrl, hostOf } from "../extraction/product.js";
import type { ComparisonRow, CostBreakdown, DataMode, Money, Recommendation, ResultStatus, ScoredProduct, ShoppingRequest, Source } from "../types.js";
import { fmtMoney, offerTotal } from "../compare/score.js";
import { renderSummary } from "./render.js";

const VAT_INCLUSIVE = new Set(["GB", "IE", "DE", "FR", "ES", "IT", "NL", "AU", "NZ", "IN", "JP", "SG", "AE"]);

const AVAILABILITY_LABEL: Record<string, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  preorder: "Pre-order",
  limited: "Limited stock",
  discontinued: "Discontinued",
  unknown: "Not stated",
};

function costs(sp: ScoredProduct, req: ShoppingRequest): CostBreakdown {
  const o = sp.bestOffer;
  const unknown: string[] = [];
  const itemPrice = o?.price ?? null;
  if (!itemPrice) unknown.push("Item price");
  const shipping = o?.shipping ?? null;
  if (!shipping) unknown.push("Shipping / delivery cost");
  if (req.country && VAT_INCLUSIVE.has(req.country)) unknown.push("VAT/GST is usually included in listed prices here, but this listing doesn't confirm it");
  else unknown.push("Sales tax (depends on your exact location; not stated by the seller)");
  if (o && !o.returnPolicy) unknown.push("Return shipping cost, if you send it back");
  let knownTotal: Money | null = null;
  if (itemPrice) {
    const t = o ? offerTotal(o) : null;
    knownTotal = t !== null ? { amount: Math.round(t * 100) / 100, currency: itemPrice.currency } : null;
  }
  return { productId: sp.product.id, itemPrice, shipping, knownTotal, unknownCosts: unknown };
}

function keySpecs(sp: ScoredProduct): string {
  const preferred = ["battery life", "weight", "capacity", "noise level", "dimensions", "width", "connectivity", "bluetooth version", "energy rating"];
  const specs = sp.product.specs;
  const picked = preferred
    .map((k) => specs.find((s) => s.name.toLowerCase().includes(k)))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  const list = (picked.length ? picked : specs).slice(0, 3);
  return list.length ? list.map((s) => `${s.name}: ${s.value}`).join("; ") : "Not stated";
}

function row(sp: ScoredProduct): ComparisonRow {
  const o = sp.bestOffer;
  const rating = sp.product.reviews.find((r) => r.rating);
  const delivery = o
    ? [o.shipping ? (o.shipping.amount === 0 ? "Free shipping" : `Shipping ${fmtMoney(o.shipping)}`) : "Shipping not stated", o.deliveryDays ? `${o.deliveryDays.min}–${o.deliveryDays.max} days` : null]
        .filter(Boolean)
        .join(", ")
    : "Not stated";
  return {
    productId: sp.product.id,
    name: sp.product.name + (sp.product.variant ? ` (${sp.product.variant})` : ""),
    price: o?.price ? `${fmtMoney(o.price)}${o.variant && sp.product.offers.length > 1 ? ` (${o.variant})` : ""}` : "Not stated",
    availability: AVAILABILITY_LABEL[o?.availability ?? "unknown"] ?? "Not stated",
    delivery,
    warrantyReturns: [o?.warranty ? `Warranty: ${o.warranty}` : "Warranty: not stated", o?.returnPolicy ?? "Returns: not stated"].join(" · "),
    rating: rating ? rating.summary : "No rating found",
    keySpecs: keySpecs(sp),
  };
}

function tradeoff(alt: ScoredProduct, best: ScoredProduct | null): string {
  if (!alt.eligible) return `${alt.ineligibleReason ?? "Not recommended"}. ${alt.fit.concerns[0] ?? ""}`.trim();
  if (!best) return alt.fit.reasons[0] ?? "Comparable option";
  const a = alt.bestOffer ? offerTotal(alt.bestOffer) : null;
  const b = best.bestOffer ? offerTotal(best.bestOffer) : null;
  const parts: string[] = [];
  if (a !== null && b !== null && alt.bestOffer?.price?.currency === best.bestOffer?.price?.currency) {
    const diff = Math.round((a - b) * 100) / 100;
    const cur = alt.bestOffer!.price!.currency;
    if (diff < 0) parts.push(`${fmtMoney({ amount: -diff, currency: cur })} cheaper`);
    else if (diff > 0) parts.push(`${fmtMoney({ amount: diff, currency: cur })} more`);
    else parts.push("Same price");
  }
  const plus = alt.fit.reasons.find((r) => !best.fit.reasons.includes(r));
  const minus = alt.fit.concerns.find((c) => !best.fit.concerns.includes(c)) ?? alt.fit.concerns[0];
  if (plus) parts.push(plus.charAt(0).toLowerCase() + plus.slice(1));
  return `${parts.join(", ")}${minus ? ` — but ${minus.charAt(0).toLowerCase() + minus.slice(1)}` : ""}`;
}

function linkFor(url: string): { url: string; affiliate: boolean } {
  const clean = cleanProductUrl(url);
  const host = hostOf(clean);
  const tag = Object.entries(config.affiliateTags).find(([h]) => host === h || host.endsWith(`.${h}`))?.[1];
  if (!tag) return { url: clean, affiliate: false };
  const u = new URL(clean);
  u.searchParams.set(tag.param, tag.value);
  return { url: u.href, affiliate: true };
}

export interface BuildInput {
  request: ShoppingRequest;
  ranked: ScoredProduct[];
  dataMode: DataMode;
  checkedAt: string;
  failures: { url: string; reason: string }[];
  notes?: string[];
}

export function buildRecommendation(input: BuildInput): Recommendation {
  const { request, dataMode, checkedAt, failures } = input;
  const ranked = input.ranked.slice(0, config.maxProducts);
  const bestSp = ranked.find((r) => r.eligible) ?? null;
  const altSps = ranked.filter((r) => r !== bestSp).slice(0, 2);

  const uncertainties: string[] = [...(input.notes ?? [])];
  for (const f of failures) uncertainties.push(`Couldn't check ${hostOf(f.url) || f.url}: ${f.reason}`);
  for (const sp of ranked) {
    for (const u of sp.product.unknowns) uncertainties.push(`${sp.product.name}: ${u}`);
    for (const c of sp.product.conflicts) uncertainties.push(`${sp.product.name}: sources disagree on ${c.spec} (${c.values.map((v) => `${v.value} per ${hostOf(v.source.url)}`).join(" vs ")})`);
    for (const w of sp.product.warnings) uncertainties.push(`${sp.product.name}: ${w}`);
  }
  if (ranked.length && !ranked.some((r) => r.product.reviews.some((x) => x.kind === "independent_review" || x.kind === "search_snippet"))) {
    uncertainties.push("No independent reviews were found for these products; ratings shown are hosted by sellers");
  }

  let status: ResultStatus;
  if (!bestSp) status = "insufficient";
  else if (failures.length || (ranked.length < 3 && request.kind !== "compare_links" && request.kind !== "deal_check")) status = "partial";
  else status = "complete";

  const links = ranked.flatMap((sp) => {
    const url = sp.bestOffer?.url ?? sp.product.offers[0]?.url ?? sp.product.specs[0]?.source.url;
    if (!url) return [];
    const l = linkFor(url);
    return [{ productId: sp.product.id, name: sp.product.name, url: l.url, affiliate: l.affiliate }];
  });

  const disclosures: string[] = [
    "Choovio gives advice only. It never buys anything, moves your money, or asks for retailer logins.",
    "Rankings are based on fit to your needs and value. Affiliate commission never affects the order.",
  ];
  if (links.some((l) => l.affiliate)) disclosures.push("Some links are affiliate links (marked). Choovio may earn a commission if you buy through them, at no extra cost to you.");
  if (dataMode === "demo") disclosures.unshift("DEMO DATA — these products, prices and reviews are fictional samples for testing, not live research.");

  const sourceMap = new Map<string, Source>();
  for (const sp of ranked) {
    for (const s of [...sp.product.offers.map((o) => o.source), ...sp.product.specs.map((x) => x.source), ...sp.product.reviews.map((r) => r.source)]) {
      if (!sourceMap.has(`${s.url}|${s.kind}`)) sourceMap.set(`${s.url}|${s.kind}`, s);
    }
  }

  const rec: Recommendation = {
    status,
    dataMode,
    checkedAt,
    request,
    best: bestSp ? { productId: bestSp.product.id, why: bestSp.fit.reasons.slice(0, 4) } : null,
    alternatives: altSps.map((a) => ({ productId: a.product.id, tradeoff: tradeoff(a, bestSp) })),
    table: ranked.map(row),
    costs: ranked.map((sp) => costs(sp, request)),
    avoidIf: ranked.map((sp) => ({
      productId: sp.product.id,
      reasons: sp.fit.concerns.length ? sp.fit.concerns.slice(0, 4) : ["No specific red flags found in the sources checked"],
    })),
    links,
    products: ranked,
    sources: [...sourceMap.values()],
    uncertainties: [...new Set(uncertainties)],
    disclosures,
    summary: "",
  };
  rec.summary = renderSummary(rec);
  return rec;
}
