/**
 * ACP offering "Shopping Comparison": requirement schema, validation and the
 * deliverable format returned to ACP consumers.
 */
import { z } from "zod";
import { config } from "../config.js";
import { COUNTRIES, normalizeCountry } from "../research/intent.js";
import { parseExternalUrl } from "../security/url.js";
import type { Recommendation } from "../types.js";

export const OFFERING_NAME = config.acp.offeringName;

export const OFFERING_DESCRIPTION =
  "Choovio researches real products for a shopping need (or compares up to 5 product links) and returns a sourced purchase recommendation: " +
  "best choice, two alternatives, comparison table, known and unknown costs, reasons to avoid each, and links — with sources, check times and uncertainties. " +
  "Advice only: Choovio never purchases, moves funds, or handles retailer credentials. Rankings are never influenced by affiliate commission.";

/** JSON schema registered with the offering (validated by ACP at job creation). */
export const REQUIREMENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    request: { type: "string", description: "What the buyer needs, in plain language. Required unless product_urls is given.", maxLength: 2000 },
    product_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 5, description: "Up to 5 public product page URLs to compare." },
    budget: { type: "number", exclusiveMinimum: 0, description: "Maximum total spend per item." },
    currency: { type: "string", pattern: "^[A-Z]{3}$", description: "ISO-4217 currency code, e.g. USD." },
    delivery_country: { type: "string", pattern: "^[A-Z]{2}$", description: "ISO-3166 alpha-2 delivery country, e.g. US. No street address." },
    preferences: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 10, description: "What matters most, e.g. 'comfortable for long calls'." },
  },
  required: ["delivery_country"],
  additionalProperties: false,
} as const;

export const DELIVERABLE_DESCRIPTION =
  "JSON: { status: complete|partial|insufficient, checked_at, best, alternatives[2], comparison_table, costs, avoid_if, links, sources[{url,kind,checked_at}], uncertainties, disclosures, summary_markdown }";

const RequirementSchema = z
  .object({
    request: z.string().trim().max(2000).optional(),
    product_urls: z.array(z.string().trim().max(2048)).max(5).optional(),
    budget: z.number().positive().max(1_000_000).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    delivery_country: z.string().trim().min(2),
    preferences: z.array(z.string().trim().max(100)).max(10).optional(),
  })
  .strict();

export type Requirement = z.infer<typeof RequirementSchema>;

export type ValidationResult = { ok: true; value: Requirement } | { ok: false; errors: string[] };

const ADDRESS_HINT = /\b\d{1,5}\s+[a-z0-9.'-]+(\s+[a-z0-9.'-]+){0,3}\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b/i;

/** Validate a client's requirement before we accept (set a budget for) the job. */
export function validateRequirement(raw: unknown): ValidationResult {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { request: raw };
    }
  }
  const parsed = RequirementSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  }
  const v = parsed.data;
  const errors: string[] = [];
  if (!v.request && !(v.product_urls && v.product_urls.length)) errors.push("Provide either 'request' or at least one 'product_urls' entry.");
  const country = normalizeCountry(v.delivery_country);
  if (!country || country.length !== 2) errors.push("delivery_country must be an ISO-3166 alpha-2 code like US or GB.");
  else v.delivery_country = country;
  if (country && !COUNTRIES[country]) {
    // Still allowed, but we have no default currency for it.
    if (!v.currency) errors.push(`Please include 'currency' for delivery_country ${country}.`);
  }
  for (const u of v.product_urls ?? []) {
    try {
      parseExternalUrl(u);
    } catch (e) {
      errors.push(`product_urls: ${u.slice(0, 100)} rejected (${(e as Error).message}).`);
    }
  }
  if (v.request && ADDRESS_HINT.test(v.request)) errors.push("Please remove the street address — Choovio only needs the delivery country.");
  if (!v.budget && v.request && !(v.product_urls?.length) && !/\d/.test(v.request)) {
    errors.push("Please include 'budget' for open-ended searches so the comparison is useful.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

/** Structured deliverable for ACP consumers: same facts as the human summary. */
export function toDeliverable(rec: Recommendation) {
  const product = (id: string) => rec.products.find((p) => p.product.id === id);
  return {
    agent: "Choovio",
    offering: OFFERING_NAME,
    status: rec.status,
    data_mode: rec.dataMode,
    checked_at: rec.checkedAt,
    request: {
      query: rec.request.query,
      kind: rec.request.kind,
      budget: rec.request.budget,
      currency: rec.request.currency,
      delivery_country: rec.request.country,
      preferences: rec.request.preferences,
    },
    best: rec.best ? { product_id: rec.best.productId, name: product(rec.best.productId)?.product.name, why: rec.best.why } : null,
    alternatives: rec.alternatives.map((a) => ({ product_id: a.productId, name: product(a.productId)?.product.name, tradeoff: a.tradeoff })),
    comparison_table: rec.table,
    products: rec.products.map((sp) => ({
      product_id: sp.product.id,
      name: sp.product.name,
      brand: sp.product.brand,
      model: sp.product.model,
      variant: sp.product.variant,
      gtin: sp.product.gtin,
      score: sp.score,
      eligible: sp.eligible,
      ineligible_reason: sp.ineligibleReason ?? null,
      within_budget: sp.withinBudget,
      offer: sp.bestOffer
        ? {
            price: sp.bestOffer.price,
            list_price_claimed: sp.bestOffer.listPrice,
            availability: sp.bestOffer.availability,
            seller: sp.bestOffer.seller,
            shipping: sp.bestOffer.shipping,
            ships_to_country: sp.bestOffer.shipsToCountry,
            delivery_days: sp.bestOffer.deliveryDays,
            returns: sp.bestOffer.returnPolicy,
            warranty: sp.bestOffer.warranty,
            url: sp.bestOffer.url,
            source: sp.bestOffer.source,
          }
        : null,
      specs: sp.product.specs.slice(0, 12).map((s) => ({ name: s.name, value: s.value, source_kind: s.source.kind, source_url: s.source.url })),
      spec_conflicts: sp.product.conflicts,
      reviews: sp.product.reviews.map((r) => ({ kind: r.kind, summary: r.summary, url: r.url })),
      complaints: sp.product.complaints.map((c) => ({ text: c.text, quote: c.quote, url: c.source.url })),
      unknowns: sp.product.unknowns,
      warnings: sp.product.warnings,
    })),
    costs: rec.costs,
    avoid_if: rec.avoidIf,
    links: rec.links,
    sources: rec.sources.map((s) => ({ url: s.url, kind: s.kind, checked_at: s.checkedAt })),
    uncertainties: rec.uncertainties,
    disclosures: rec.disclosures,
    summary_markdown: rec.summary,
  };
}

export function offeringConfig() {
  return {
    name: OFFERING_NAME,
    description: OFFERING_DESCRIPTION,
    priceType: "fixed" as const,
    priceValue: config.acp.priceUsdc,
    slaMinutes: config.acp.slaMinutes,
    requirements: REQUIREMENT_JSON_SCHEMA,
    deliverable: DELIVERABLE_DESCRIPTION,
    requiredFunds: false,
    hidden: false,
  };
}
