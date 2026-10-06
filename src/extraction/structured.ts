/**
 * Deterministic extraction of product facts from structured page data:
 * schema.org JSON-LD, OpenGraph/product meta tags and HTML spec tables.
 *
 * Nothing here is inferred: a field is filled only when the page states it in
 * machine-readable form. Everything else stays null.
 */
import { cleanDisplay, decodeEntities } from "../security/untrusted.js";
import type { Availability } from "../types.js";

type Json = Record<string, unknown>;

export interface RawOffer {
  price: number | null;
  currency: string | null;
  listPrice: number | null;
  availability: Availability;
  seller: string | null;
  url: string | null;
  shipping: { amount: number; currency: string | null; countries: string[] } | null;
  deliveryDays: { min: number; max: number } | null;
  returnDays: number | null;
  returnPolicy: string | null;
  shipsTo: string[];
  variant?: string | null;
}

export interface RawProduct {
  name: string | null;
  brand: string | null;
  model: string | null;
  sku: string | null;
  gtin: string | null;
  color: string | null;
  size: string | null;
  image: string | null;
  description: string | null;
  offers: RawOffer[];
  rating: { value: number; best: number; count: number | null } | null;
  specs: { name: string; value: string }[];
  warranty: string | null;
  reviews: { author: string | null; rating: number | null; body: string }[];
}

export interface PageExtraction {
  title: string | null;
  canonical: string | null;
  products: RawProduct[];
  /** schema.org ProductGroup (the parent of size/colour variants), if present. */
  group: RawProduct | null;
  metaPrice: { amount: number; currency: string | null } | null;
  metaAvailability: Availability;
  /** og:image / twitter:image / image_src — the page's preview image. */
  metaImage: string | null;
  tableSpecs: { name: string; value: string }[];
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function typeOf(node: Json): string[] {
  return asArray(node["@type"] as string | string[]).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ""));
}

function str(v: unknown, max = 200): string | null {
  if (v && typeof v === "object") {
    const o = v as Json;
    return str(o.name ?? o["@value"] ?? o.value, max);
  }
  return cleanDisplay(v, max);
}

/** First usable image reference: a URL string, or an ImageObject's url/contentUrl/thumbnailUrl. Never truncated. */
function imageRef(v: unknown): string | null {
  for (const item of asArray(v as unknown)) {
    let raw: unknown = item;
    if (item && typeof item === "object") {
      const o = item as Json;
      raw = o.url ?? o.contentUrl ?? o.thumbnailUrl ?? o["@id"];
      if (Array.isArray(raw)) raw = raw[0];
    }
    if (typeof raw !== "string") continue;
    const url = decodeEntities(raw).trim();
    if (url && url.length <= 2000 && !url.endsWith("…") && !/\s/.test(url) && !/^data:/i.test(url)) return url;
  }
  return null;
}

export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.299,99" (EU) vs "1,299.99" (US)
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseAvailability(v: unknown): Availability {
  const s = String(v ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/instock|in_stock|in stock|onlineonly|instoreonly/.test(s)) return "in_stock";
  if (/limitedavailability|limited/.test(s)) return "limited";
  if (/preorder|presale|backorder/.test(s)) return "preorder";
  if (/discontinued/.test(s)) return "discontinued";
  if (/outofstock|out_of_stock|out of stock|soldout|sold out|oos/.test(s)) return "out_of_stock";
  return "unknown";
}

function collectJsonLd(html: string): Json[] {
  const nodes: Json[] = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]!.trim().replace(/^<!\[CDATA\[|\]\]>$/g, ""));
      const visit = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (n && typeof n === "object") {
          const o = n as Json;
          nodes.push(o);
          if (o["@graph"]) visit(o["@graph"]);
          if (o.hasVariant) visit(o.hasVariant);
          if (o.mainEntity) visit(o.mainEntity);
        }
      };
      visit(parsed);
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  }
  return nodes;
}

function parseDuration(v: unknown): number | null {
  const s = String(v ?? "");
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?/i.exec(s);
  if (!m || !s) return null;
  return Number(m[1] ?? 0) * 365 + Number(m[2] ?? 0) * 30 + Number(m[3] ?? 0);
}

function parseOffer(o: Json, fallbackCurrency: string | null): RawOffer[] {
  const types = typeOf(o);
  if (types.includes("AggregateOffer")) {
    const inner = asArray(o.offers as Json | Json[]);
    if (inner.length) return inner.flatMap((x) => parseOffer(x, str(o.priceCurrency) ?? fallbackCurrency));
    const low = parsePrice(o.lowPrice ?? o.price);
    return [
      {
        price: low,
        currency: str(o.priceCurrency) ?? fallbackCurrency,
        listPrice: null,
        availability: parseAvailability(o.availability),
        seller: str(o.seller),
        url: str(o.url, 2000),
        shipping: null,
        deliveryDays: null,
        returnDays: null,
        returnPolicy: null,
        shipsTo: [],
      },
    ];
  }
  const spec = asArray(o.priceSpecification as Json | Json[]);
  const listSpec = spec.find((p) => /ListPrice|StrikethroughPrice|MSRP/i.test(String(p.priceType ?? "")));
  const saleSpec = spec.find((p) => p !== listSpec);
  const price = parsePrice(o.price ?? saleSpec?.price);
  const currency = str(o.priceCurrency ?? saleSpec?.priceCurrency) ?? fallbackCurrency;

  let shipping: RawOffer["shipping"] = null;
  let deliveryDays: RawOffer["deliveryDays"] = null;
  const shipsTo: string[] = [];
  for (const sd of asArray(o.shippingDetails as Json | Json[])) {
    const rate = sd.shippingRate as Json | undefined;
    const countries = asArray(sd.shippingDestination as Json | Json[])
      .map((d) => str(d.addressCountry))
      .filter((c): c is string => Boolean(c))
      .map((c) => c.toUpperCase());
    shipsTo.push(...countries);
    if (rate && !shipping) {
      const amount = parsePrice(rate.value);
      if (amount !== null) shipping = { amount, currency: str(rate.currency) ?? currency, countries };
    }
    const dt = sd.deliveryTime as Json | undefined;
    if (dt && !deliveryDays) {
      const h = dt.handlingTime as Json | undefined;
      const tt = dt.transitTime as Json | undefined;
      const min = Number(h?.minValue ?? 0) + Number(tt?.minValue ?? 0);
      const max = Number(h?.maxValue ?? 0) + Number(tt?.maxValue ?? 0);
      if (max > 0) deliveryDays = { min, max };
    }
  }

  let returnDays: number | null = null;
  let returnPolicy: string | null = null;
  const rp = asArray(o.hasMerchantReturnPolicy as Json | Json[])[0];
  if (rp) {
    const days = Number(rp.merchantReturnDays);
    returnDays = Number.isFinite(days) && days > 0 ? days : null;
    const cat = String(rp.returnPolicyCategory ?? "");
    if (/NotPermitted/i.test(cat)) returnPolicy = "Returns not permitted";
    else if (/Unlimited/i.test(cat)) returnPolicy = "Unlimited return window";
    else if (returnDays) returnPolicy = `${returnDays}-day returns`;
    const fees = String(rp.returnFees ?? "");
    if (/FreeReturn/i.test(fees)) returnPolicy = `${returnPolicy ?? "Returns accepted"}, free returns`;
    else if (/ReturnShippingFees|RestockingFees|CustomerResponsibility/i.test(fees)) returnPolicy = `${returnPolicy ?? "Returns accepted"}, buyer may pay return costs`;
  }

  return [
    {
      price,
      currency: currency ? currency.toUpperCase() : null,
      listPrice: listSpec ? parsePrice(listSpec.price) : null,
      availability: parseAvailability(o.availability),
      seller: str(o.seller),
      url: str(o.url, 2000),
      shipping,
      deliveryDays,
      returnDays,
      returnPolicy,
      shipsTo: [...new Set(shipsTo)],
    },
  ];
}

function parseProductNode(p: Json): RawProduct {
  const offers = asArray(p.offers as Json | Json[]).flatMap((o) => parseOffer(o, null));
  const agg = p.aggregateRating as Json | undefined;
  let rating: RawProduct["rating"] = null;
  if (agg) {
    const value = Number(agg.ratingValue);
    const best = Number(agg.bestRating ?? 5);
    const count = Number(agg.reviewCount ?? agg.ratingCount);
    if (Number.isFinite(value) && value > 0) rating = { value, best: Number.isFinite(best) && best > 0 ? best : 5, count: Number.isFinite(count) ? count : null };
  }
  const specs: { name: string; value: string }[] = [];
  for (const prop of asArray(p.additionalProperty as Json | Json[])) {
    const name = str(prop.name, 80);
    const value = str(prop.value ?? prop.description, 200);
    const unit = str(prop.unitText ?? prop.unitCode, 20);
    if (name && value) specs.push({ name, value: unit && !value.includes(unit) ? `${value} ${unit}` : value });
  }
  for (const key of ["weight", "width", "height", "depth", "material", "color", "size"]) {
    const v = str(p[key], 80);
    if (v) specs.push({ name: key[0]!.toUpperCase() + key.slice(1), value: v });
  }
  const firstRawOffer = asArray(p.offers as Json | Json[])[0];
  const warrantyNode = asArray(p.warranty as Json | Json[])[0] ?? asArray(firstRawOffer?.warranty as Json | Json[])[0];
  let warranty: string | null = null;
  if (warrantyNode && typeof warrantyNode === "object") {
    const dur = warrantyNode.durationOfWarranty;
    if (dur && typeof dur === "object" && (dur as Json).value !== undefined) {
      const d = dur as Json;
      const unit = str(d.unitText) ?? str(d.unitCode) ?? "";
      warranty = `${str(d.value)} ${Number(d.value) === 1 ? unit.replace(/s$/i, "") : unit}`.trim();
    } else {
      const days = parseDuration(dur);
      warranty = days ? (days >= 365 ? `${Math.round(days / 365)} year(s)` : `${days} days`) : str(warrantyNode, 120);
    }
  } else if (warrantyNode) {
    warranty = str(warrantyNode, 120);
  }
  const reviews = asArray(p.review as Json | Json[])
    .slice(0, 20)
    .map((r) => ({
      author: str(r.author, 60),
      rating: Number((r.reviewRating as Json | undefined)?.ratingValue) || null,
      body: str(r.reviewBody ?? r.description, 600) ?? "",
    }))
    .filter((r) => r.body);
  const gtin = str(p.gtin13 ?? p.gtin12 ?? p.gtin14 ?? p.gtin8 ?? p.gtin, 20);
  return {
    name: str(p.name, 200),
    brand: str(p.brand ?? p.manufacturer, 80),
    model: str(p.mpn ?? p.model, 80),
    sku: str(p.sku, 80),
    gtin,
    color: str(p.color, 60),
    size: str(p.size, 60),
    image: imageRef(p.image),
    description: str(p.description, 600),
    offers,
    rating,
    specs,
    warranty,
    reviews,
  };
}

function meta(html: string, prop: string, max = 300): string | null {
  const re = new RegExp(String.raw`<meta[^>]+(?:property|name|itemprop)\s*=\s*["']${prop.replace(/[:.]/g, "\\$&")}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? cleanDisplay(content, max) : null;
}

function linkImageSrc(html: string): string | null {
  const tag = /<link[^>]+rel\s*=\s*["']image_src["'][^>]*>/i.exec(html)?.[0];
  return tag ? (/href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? null) : null;
}

function extractTableSpecs(html: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const clean = (s: string) => cleanDisplay(decodeEntities(s.replace(/<[^>]+>/g, " ")), 160);
  const rowRe = /<tr\b[^>]*>\s*<(?:th|td)\b[^>]*>([\s\S]{1,200}?)<\/(?:th|td)>\s*<td\b[^>]*>([\s\S]{1,400}?)<\/td>\s*<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) && out.length < 60) {
    const name = clean(m[1]!);
    const value = clean(m[2]!);
    if (name && value && name.length < 60) out.push({ name, value });
  }
  const dlRe = /<dt\b[^>]*>([\s\S]{1,200}?)<\/dt>\s*<dd\b[^>]*>([\s\S]{1,400}?)<\/dd>/gi;
  while ((m = dlRe.exec(html)) && out.length < 60) {
    const name = clean(m[1]!);
    const value = clean(m[2]!);
    if (name && value && name.length < 60) out.push({ name, value });
  }
  return out;
}

export function extractStructured(html: string): PageExtraction {
  const nodes = collectJsonLd(html);
  const productNodes = nodes.filter((n) => typeOf(n).some((t) => t === "Product" || t === "IndividualProduct" || t === "ProductModel"));
  const products = productNodes.map(parseProductNode);
  const groupNode = nodes.find((n) => typeOf(n).includes("ProductGroup"));
  const group = groupNode ? parseProductNode(groupNode) : null;

  const metaAmount = parsePrice(meta(html, "product:price:amount") ?? meta(html, "og:price:amount") ?? meta(html, "price"));
  const metaCurrency = meta(html, "product:price:currency") ?? meta(html, "og:price:currency") ?? meta(html, "priceCurrency");
  const title = cleanDisplay(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? meta(html, "og:title"), 200);
  const canonical = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;

  return {
    title,
    canonical,
    products,
    group,
    metaPrice: metaAmount !== null ? { amount: metaAmount, currency: metaCurrency?.toUpperCase() ?? null } : null,
    metaAvailability: parseAvailability(meta(html, "product:availability") ?? meta(html, "og:availability")),
    metaImage: imageRef(meta(html, "og:image:secure_url", 2000) ?? meta(html, "og:image", 2000) ?? meta(html, "og:image:url", 2000) ?? meta(html, "twitter:image", 2000) ?? meta(html, "twitter:image:src", 2000) ?? meta(html, "image", 2000) ?? linkImageSrc(html)),
    tableSpecs: extractTableSpecs(html),
  };
}
