/**
 * Builds a ProductRecord (with provenance on every fact) from a fetched page.
 */
import crypto from "node:crypto";
import { cleanDisplay, htmlToText, scanForInjection } from "../security/untrusted.js";
import type { Complaint, DataMode, Money, Offer, ProductRecord, ReviewEvidence, Source, SourceKind, SpecValue } from "../types.js";
import { extractStructured, type RawOffer, type RawProduct } from "./structured.js";

export const INDEPENDENT_REVIEW_HOSTS = [
  "rtings.com", "nytimes.com", "wirecutter.com", "consumerreports.org", "which.co.uk", "techradar.com", "tomsguide.com",
  "theverge.com", "cnet.com", "pcmag.com", "soundguys.com", "whathifi.com", "engadget.com", "wired.com", "goodhousekeeping.com",
  "choice.com.au", "stiftung-warentest.de", "notebookcheck.net", "gsmarena.com", "dpreview.com", "outdoorgearlab.com", "reviewed.com",
];

const AFFILIATE_HOSTS = ["amzn.to", "go.skimresources.com", "click.linksynergy.com", "awin1.com", "shareasale.com", "rstyle.me", "howl.me", "go.redirectingat.com", "anrdoezrs.net", "jdoqocy.com", "tkqlhce.com", "dpbolvw.net", "pntra.com", "avantlink.com"];
const AFFILIATE_PARAMS = ["tag", "affid", "aff_id", "affiliate", "affiliate_id", "clickid", "irclickid", "ranmid", "ranEAID", "subid", "aff", "partner", "linkCode"];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isAffiliateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (AFFILIATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    return AFFILIATE_PARAMS.some((p) => u.searchParams.has(p));
  } catch {
    return false;
  }
}

/** Remove known tracking/affiliate parameters so the user gets a clean link. */
export function cleanProductUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...AFFILIATE_PARAMS, "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref", "ref_"]) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

export function isManufacturerHost(url: string, brand: string | null): boolean {
  if (!brand) return false;
  const b = slug(brand);
  if (b.length < 3) return false;
  return slug(hostOf(url).split(".").slice(0, -1).join("")).includes(b);
}

export function isIndependentReviewHost(url: string): boolean {
  const host = hostOf(url);
  return INDEPENDENT_REVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function money(amount: number | null, currency: string | null): Money | null {
  return amount !== null && currency ? { amount, currency: currency.toUpperCase() } : null;
}

const COMPLAINT_THEMES: { theme: string; re: RegExp }[] = [
  { theme: "Battery life shorter than expected", re: /\bbattery\b[^.]{0,60}\b(dies|died|drain|short|poor|bad|weak|only lasts?)/i },
  { theme: "Comfort problems in long sessions", re: /\b(uncomfortable|hurts?|pinch(es|ing)?|ear ?ache|headache|too tight|clamp)/i },
  { theme: "Connectivity / Bluetooth drop-outs", re: /\b(disconnect(s|ed|ing)?|drop(s|ped)? (out|connection)|pairing (issue|problem)|connection (issue|problem)s?|bluetooth (issue|problem)s?)/i },
  { theme: "Microphone quality complaints", re: /\b(mic|microphone)\b[^.]{0,60}\b(muffled|poor|bad|terrible|can'?t hear|quiet|tinny)/i },
  { theme: "Durability — broke or failed early", re: /\b(broke|broken|stopped working|died after|fell apart|cracked|snapped|defective|failed after)\b/i },
  { theme: "Noisy in operation", re: /\b(too loud|very loud|noisy|rattl(e|es|ing)|squeak(s|y|ing)?)\b/i },
  { theme: "Customer service / warranty difficulties", re: /\b(customer service|support|warranty (claim|denied)|refund (refused|denied)|no response)\b/i },
  { theme: "Leaks", re: /\b(leak(s|ed|ing)?)\b/i },
  { theme: "Size or fit not as described", re: /\b(smaller than|bigger than|larger than|doesn'?t fit|did not fit|wrong size|runs (small|large))\b/i },
];

/** Recurring complaints: a theme counts only if it appears in at least two low-rated reviews. */
export function recurringComplaints(reviews: RawProduct["reviews"], source: Source): Complaint[] {
  const low = reviews.filter((r) => r.rating !== null && r.rating <= 2.5);
  const out: Complaint[] = [];
  for (const { theme, re } of COMPLAINT_THEMES) {
    const hits = low.filter((r) => re.test(r.body));
    if (hits.length >= 2) {
      const sentence = hits[0]!.body.split(/(?<=[.!?])\s+/).find((s) => re.test(s)) ?? hits[0]!.body;
      out.push({ text: `${theme} (${hits.length} of ${low.length} low-rated reviews on this page)`, quote: sentence.slice(0, 240), source });
    }
  }
  return out;
}

const STOCK_TEXT: { re: RegExp; availability: Offer["availability"] }[] = [
  { re: /\b(currently unavailable|out of stock|sold out|no longer available|temporarily unavailable)\b/i, availability: "out_of_stock" },
  { re: /\bdiscontinued\b/i, availability: "discontinued" },
];

function warrantyFromText(text: string): string | null {
  const m = /\b(\d{1,2})[- ](year|yr|month)s?\b[^.\n]{0,30}\b(warranty|guarantee)\b/i.exec(text) ?? /\b(warranty|guarantee)\b[^.\n]{0,20}?\b(\d{1,2})[- ](year|yr|month)s?\b/i.exec(text);
  if (!m) return null;
  return cleanDisplay(m[0], 80);
}

/** "Men's Runner - Black | Allbirds" → "Men's Runner - Black" */
export function stripSiteSuffix(title: string): string {
  return title.replace(/\s+[|–—]\s+[^|–—]{2,40}$/, "").trim();
}

function commonPrefix(names: string[]): string {
  if (!names.length) return "";
  let p = names[0]!;
  for (const n of names.slice(1)) while (p && !n.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/[\s\-–—/,(|]+$/, "").trim();
}

/** Fold variant nodes (sizes, colours) into a single product whose offers carry the variant label. */
export function collapseVariants(variants: RawProduct[], group: RawProduct | null): RawProduct {
  const names = variants.map((v) => v.name ?? "").filter(Boolean);
  let prefix = commonPrefix(names);
  if (group?.name && names.every((n) => n.startsWith(group.name!))) prefix = group.name;
  else {
    // Back off to the last separator so labels stay whole ("Size 10", not "10").
    const seps = [...prefix.matchAll(/\s[-–—|/]\s|,\s|\s\(/g)];
    const last = seps[seps.length - 1];
    if (last?.index !== undefined && names.some((n) => n.length > prefix.length)) prefix = prefix.slice(0, last.index);
  }
  const first = variants[0]!;
  const looksLikeVariants = Boolean(group) || (prefix.length >= 8 && prefix.length >= 0.5 * Math.min(...names.map((n) => n.length)));
  if (!looksLikeVariants) return first;
  const label = (v: RawProduct): string | null => {
    const rest = (v.name ?? "").slice(prefix.length).replace(/^[\s\-–—/,(|]+|[)\s]+$/g, "");
    return rest || [v.color, v.size].filter(Boolean).join(" / ") || v.sku || null;
  };
  const colors = new Set(variants.map((v) => v.color).filter(Boolean));
  return {
    name: group?.name ?? (prefix || first.name),
    brand: group?.brand ?? first.brand,
    model: group?.model ?? null,
    sku: null,
    gtin: null,
    color: colors.size === 1 ? [...colors][0]! : null,
    size: null,
    image: group?.image ?? first.image,
    description: group?.description ?? first.description,
    offers: variants.flatMap((v) => v.offers.map((o) => ({ ...o, variant: label(v) }))),
    rating: group?.rating ?? first.rating,
    specs: [...(group?.specs ?? []), ...first.specs.filter((s) => !/^(size|color)$/i.test(s.name))],
    warranty: group?.warranty ?? first.warranty,
    reviews: [...(group?.reviews ?? []), ...first.reviews],
  };
}

export interface BuildOptions {
  url: string;
  html: string;
  checkedAt: string;
  dataMode: DataMode;
  country: string | null;
}

export interface BuiltPage {
  products: ProductRecord[];
  pageText: string;
  injection: { suspicious: boolean; matches: string[] };
  pageKind: SourceKind;
}

export function buildFromPage(opts: BuildOptions): BuiltPage {
  const { url, html, checkedAt, dataMode, country } = opts;
  const extraction = extractStructured(html);
  const pageText = htmlToText(html);
  // Scan visible text, hidden markup and structured fields: hidden text is never shown or used, but we report it.
  const allText = html.replace(/<(script|style)\b(?![^>]*ld\+json)[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " ");
  const injection = scanForInjection(`${pageText}\n${allText}\n${extraction.products.map((p) => `${p.name ?? ""} ${p.description ?? ""}`).join("\n")}`);
  const title = extraction.title ?? undefined;
  const reviewSite = isIndependentReviewHost(url);

  const titleName = extraction.title ? stripSiteSuffix(extraction.title) : null;
  // One product page = one product. Size/colour variants become offers on that product;
  // unrelated products listed on the same page (e.g. "you may also like") are ignored.
  const raws: RawProduct[] = extraction.products.length
    ? [extraction.products.length > 1 ? collapseVariants(extraction.products, extraction.group) : extraction.products[0]!]
    : extraction.metaPrice || titleName
      ? [{ name: titleName, brand: null, model: null, sku: null, gtin: null, color: null, size: null, image: null, description: null, offers: [], rating: null, specs: [], warranty: null, reviews: [] }]
      : [];

  const products = raws.map((raw): ProductRecord => {
    const manufacturer = isManufacturerHost(url, raw.brand);
    const pageKind: SourceKind = reviewSite ? "independent_review" : manufacturer ? "manufacturer_spec" : "retailer_listing";
    const src = (kind: SourceKind): Source => ({ url, title, kind, checkedAt });
    const unknowns: string[] = [];
    const warnings: string[] = [];

    let rawOffers: RawOffer[] = raw.offers;
    if (!rawOffers.length && extraction.metaPrice) {
      rawOffers = [{ price: extraction.metaPrice.amount, currency: extraction.metaPrice.currency, listPrice: null, availability: extraction.metaAvailability, seller: null, url: null, shipping: null, deliveryDays: null, returnDays: null, returnPolicy: null, shipsTo: [] }];
    }
    const textStock = STOCK_TEXT.find((s) => s.re.test(pageText.slice(0, 20_000)));
    const pageWarranty = raw.warranty ?? warrantyFromText(pageText);

    const offers: Offer[] = reviewSite
      ? [] // review sites do not sell; their price mentions are not offers
      : rawOffers.map((o) => {
          let availability = o.availability;
          if (availability === "unknown" && textStock) availability = textStock.availability;
          const shipsToCountry = country && o.shipsTo.length ? o.shipsTo.includes(country) : null;
          return {
            price: money(o.price, o.currency),
            listPrice: o.listPrice !== null && o.listPrice > (o.price ?? 0) ? money(o.listPrice, o.currency) : null,
            availability,
            seller: o.seller,
            shipping: o.shipping && (!country || !o.shipping.countries.length || o.shipping.countries.includes(country)) ? money(o.shipping.amount, o.shipping.currency) : null,
            shipsToCountry,
            deliveryDays: o.deliveryDays,
            returnPolicy: o.returnPolicy,
            returnDays: o.returnDays,
            warranty: pageWarranty,
            url: o.url && /^https?:/i.test(o.url) ? o.url : url,
            variant: o.variant ?? null,
            source: src("retailer_listing"),
          };
        });

    const specKind: SourceKind = manufacturer ? "manufacturer_spec" : reviewSite ? "independent_review" : "retailer_listing";
    const specs: SpecValue[] = [...raw.specs, ...extraction.tableSpecs]
      .filter((s, i, arr) => arr.findIndex((x) => x.name.toLowerCase() === s.name.toLowerCase()) === i)
      .slice(0, 40)
      .map((s) => ({ ...s, source: src(specKind) }));

    const reviews: ReviewEvidence[] = [];
    if (raw.rating) {
      reviews.push({
        kind: reviewSite ? "independent_review" : "retailer_rating",
        summary: `${raw.rating.value}/${raw.rating.best}${raw.rating.count !== null ? ` from ${raw.rating.count} ratings` : ""}${reviewSite ? "" : " (hosted by the seller)"}`,
        rating: raw.rating,
        url,
        source: src(reviewSite ? "independent_review" : "retailer_rating"),
      });
    }

    const name = raw.name ?? titleName ?? "Unnamed product";
    if (!offers.length && !reviewSite) unknowns.push("No price or offer data was published on this page");
    if (offers.length && offers.every((o) => !o.price)) unknowns.push("Price not stated in machine-readable form");
    if (offers.length && offers.every((o) => o.availability === "unknown")) unknowns.push("Stock status not stated");
    if (!raw.model && !raw.gtin) unknowns.push("Exact model number not stated");
    if (!pageWarranty && !reviewSite) unknowns.push("Warranty not stated");
    if (offers.length && offers.every((o) => !o.returnPolicy)) unknowns.push("Return policy not stated on the listing");
    if (offers.length && offers.every((o) => !o.shipping)) unknowns.push("Shipping cost not stated");
    if (injection.suspicious) {
      warnings.push(`Page contains text that tries to instruct AI assistants (ignored): "${injection.matches[0]}"`);
    }

    const variantParts = [raw.color, raw.size].filter(Boolean);
    const idBasis = raw.gtin ?? raw.model ?? `${hostOf(url)}|${name}`;
    return {
      id: crypto.createHash("sha1").update(slug(idBasis)).digest("hex").slice(0, 10),
      name,
      brand: raw.brand,
      model: raw.model,
      variant: variantParts.length ? variantParts.join(" / ") : null,
      gtin: raw.gtin,
      sku: raw.sku,
      imageUrl: resolveImageUrl(raw.image, url) ?? resolveImageUrl(extraction.metaImage, url),
      offers,
      specs,
      marketingClaims: raw.description ? [{ text: raw.description, source: src("marketing_claim") }] : [],
      reviews,
      complaints: recurringComplaints(raw.reviews, src(reviewSite ? "independent_review" : "retailer_rating")),
      conflicts: [],
      unknowns,
      warnings,
      affiliate: isAffiliateUrl(url),
      dataMode,
    };
  });

  return { products, pageText, injection, pageKind: reviewSite ? "independent_review" : "retailer_listing" };
}

/** Absolute https image URL, resolved against the page (handles relative and protocol-relative paths). */
export function resolveImageUrl(ref: string | null, pageUrl: string): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref, pageUrl);
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const href = u.href;
    return href.length <= 2000 ? href : null;
  } catch {
    return null;
  }
}
