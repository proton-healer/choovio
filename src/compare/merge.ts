/**
 * Merges records describing the same product (e.g. manufacturer page + two
 * retailer listings) and flags specifications that disagree between sources.
 */
import type { ProductRecord, SpecConflict, SpecValue } from "../types.js";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sameProduct(a: ProductRecord, b: ProductRecord): boolean {
  if (a.gtin && b.gtin) return norm(a.gtin) === norm(b.gtin);
  if (a.model && b.model && norm(a.model).length >= 4) {
    const sameModel = norm(a.model) === norm(b.model);
    const brandOk = !a.brand || !b.brand || norm(a.brand) === norm(b.brand);
    // Same model but different stated variant (colour/size) → different product variant.
    const variantOk = !a.variant || !b.variant || norm(a.variant) === norm(b.variant);
    return sameModel && brandOk && variantOk;
  }
  return false;
}

const SPEC_ALIASES: Record<string, string> = {
  "battery": "battery life",
  "battery life": "battery life",
  "playback time": "battery life",
  "playtime": "battery life",
  "weight": "weight",
  "net weight": "weight",
  "capacity": "capacity",
  "drum capacity": "capacity",
  "load capacity": "capacity",
  "width": "width",
  "depth": "depth",
  "height": "height",
  "dimensions": "dimensions",
  "noise level": "noise level",
  "suction power": "suction power",
  "warranty": "warranty",
  "bluetooth": "bluetooth version",
  "bluetooth version": "bluetooth version",
  "energy rating": "energy rating",
  "energy class": "energy rating",
};

export function canonicalSpecName(name: string): string {
  const n = name.toLowerCase().replace(/[:()]/g, "").replace(/\s+/g, " ").trim();
  return SPEC_ALIASES[n] ?? n;
}

/** Extract comparable numbers (with unit) from a spec value; null if not numeric. */
function numericSignature(value: string): string | null {
  const nums = value.toLowerCase().match(/\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?|kg|g|lbs?|cm|mm|in|db|w|l|aw|pa|kwh)?/g);
  if (!nums) return null;
  return nums.map((n) => n.replace(",", ".").replace(/\s+/g, "").replace(/hours?|hrs?$/, "h")).join("|");
}

export function detectConflicts(specs: SpecValue[]): SpecConflict[] {
  const groups = new Map<string, SpecValue[]>();
  for (const s of specs) {
    const key = canonicalSpecName(s.name);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const conflicts: SpecConflict[] = [];
  for (const [spec, values] of groups) {
    const bySource = new Map<string, SpecValue>();
    for (const v of values) if (!bySource.has(v.source.url)) bySource.set(v.source.url, v);
    if (bySource.size < 2) continue;
    const sigs = new Set([...bySource.values()].map((v) => numericSignature(v.value) ?? v.value.toLowerCase().trim()));
    if (sigs.size > 1) conflicts.push({ spec, values: [...bySource.values()].map((v) => ({ value: v.value, source: v.source })) });
  }
  return conflicts;
}

export function mergeRecords(records: ProductRecord[]): ProductRecord[] {
  const merged: ProductRecord[] = [];
  for (const r of records) {
    const existing = merged.find((m) => sameProduct(m, r));
    if (!existing) {
      merged.push({ ...r, offers: [...r.offers], specs: [...r.specs], reviews: [...r.reviews], complaints: [...r.complaints], unknowns: [...r.unknowns], warnings: [...r.warnings], marketingClaims: [...r.marketingClaims] });
      continue;
    }
    existing.brand ??= r.brand;
    existing.model ??= r.model;
    existing.gtin ??= r.gtin;
    existing.variant ??= r.variant;
    existing.imageUrl ??= r.imageUrl;
    // Prefer the manufacturer's product name when we have it.
    if (r.specs.some((s) => s.source.kind === "manufacturer_spec")) existing.name = r.name;
    existing.offers.push(...r.offers);
    existing.specs.push(...r.specs);
    existing.reviews.push(...r.reviews);
    existing.complaints.push(...r.complaints);
    existing.marketingClaims.push(...r.marketingClaims);
    existing.warnings.push(...r.warnings);
    existing.affiliate ||= r.affiliate;
    // An unknown is resolved if any merged source answered it.
    existing.unknowns = existing.unknowns.filter((u) => r.unknowns.includes(u) || !resolvedBy(u, r));
  }
  for (const m of merged) {
    m.conflicts = detectConflicts(m.specs);
    m.unknowns = [...new Set(m.unknowns.filter((u) => !resolvedBy(u, m)))];
    m.warnings = [...new Set(m.warnings)];
  }
  return merged;
}

function resolvedBy(unknown: string, r: ProductRecord): boolean {
  if (/price/i.test(unknown)) return r.offers.some((o) => o.price);
  if (/stock/i.test(unknown)) return r.offers.some((o) => o.availability !== "unknown");
  if (/model number/i.test(unknown)) return Boolean(r.model || r.gtin);
  if (/warranty/i.test(unknown)) return r.offers.some((o) => o.warranty);
  if (/return/i.test(unknown)) return r.offers.some((o) => o.returnPolicy);
  if (/shipping/i.test(unknown)) return r.offers.some((o) => o.shipping);
  return false;
}
