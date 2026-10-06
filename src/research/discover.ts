/**
 * Product discovery from review roundups. Searches for "best X under $Y" mostly
 * return expert roundups rather than product pages, so the models those pages
 * recommend become seeds for a second, per-model search. Names found here are
 * only search seeds: every price and spec still comes from a fetched page.
 */
import { htmlToText } from "../security/untrusted.js";
import type { ProductRecord } from "../types.js";
import type { LlmHelper } from "./llm.js";

export interface RoundupPage {
  url: string;
  html: string;
  text: string;
}

export interface DiscoveredModel {
  name: string;
  /** Roundup pages that recommend this model, with a verbatim quote when one was checked. */
  mentions: { url: string; quote: string | null }[];
}

const NOT_A_PRODUCT = /^(best|top|our|the|how|why|what|who|where|when|which|faq|frequently|related|more|other|also|comparison|compare|methodology|testing|tested|verdict|bottom line|conclusion|final|honorable|honourable|budget|cheap|buying|things|should|is |are |do |does |can |table of|in this|about|sign up|newsletter|you may|recommended|latest|popular|trending|share|comments?)\b/i;

/** Model-like heading text from a roundup, e.g. "1. Sony WH-CH720N" or "Best overall: Anker Soundcore Q20i". */
export function headingCandidates(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]\s*>/gi)) {
    let t = htmlToText(m[1]!).replace(/\s+/g, " ").trim();
    t = t.replace(/^(#?\d{1,2}[.):]?|no\.\s*\d{1,2}[.):]?)\s+/i, "");
    // "Best overall: Sony X" → "Sony X";  "Sony X — best for calls" → "Sony X"
    const parts = t.split(/\s*(?::|\s[–—|-]\s)\s*/).filter(Boolean);
    const pick = parts.find((p) => !NOT_A_PRODUCT.test(p)) ?? "";
    const name = pick.replace(/\s*\((?:[^)]*)\)\s*$/, "").trim();
    if (looksLikeModel(name)) out.push(name);
  }
  return [...new Set(out)];
}

function looksLikeModel(s: string): boolean {
  const words = s.split(" ");
  if (s.length < 4 || s.length > 60 || words.length < 2 || words.length > 8) return false;
  if (NOT_A_PRODUCT.test(s) || /[?!]$/.test(s)) return false;
  // A capitalised brand word plus a model-ish token (digits, or a mixed-case/hyphenated code).
  return /^[A-Z0-9]/.test(s) && words.slice(1).some((w) => /\d/.test(w) || /^[A-Z][A-Za-z]*[A-Z]/.test(w) || /-/.test(w));
}

/** Models recommended across the given roundups, most-recommended first. */
export async function discoverModels(pages: RoundupPage[], llm: LlmHelper | null | undefined, query: string, limit = 5): Promise<DiscoveredModel[]> {
  const perPage = await Promise.all(
    pages.map(async (page): Promise<{ name: string; quote: string | null }[]> => {
      if (llm?.extractRecommendedProducts) {
        try {
          const found = await llm.extractRecommendedProducts(page.url, page.text, query);
          if (found.length) return found;
        } catch {
          // Fall back to headings below.
        }
      }
      return headingCandidates(page.html).slice(0, 8).map((name) => ({ name, quote: null }));
    }),
  );

  const byKey = new Map<string, DiscoveredModel & { firstSeen: number }>();
  perPage.forEach((found, pageIndex) => {
    found.forEach((f, i) => {
      const key = modelKey(f.name);
      if (!key) return;
      const existing = [...byKey.values()].find((m) => modelKey(m.name) === key || namesMatch(m.name, f.name));
      const mention = { url: pages[pageIndex]!.url, quote: f.quote };
      if (existing) {
        if (!existing.mentions.some((x) => x.url === mention.url)) existing.mentions.push(mention);
      } else {
        byKey.set(key, { name: f.name, mentions: [mention], firstSeen: i });
      }
    });
  });
  return [...byKey.values()]
    .sort((a, b) => b.mentions.length - a.mentions.length || a.firstSeen - b.firstSeen)
    .slice(0, limit)
    .map(({ name, mentions }) => ({ name, mentions }));
}

function modelKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/** Every token of the shorter name appears in the longer one ("WH-CH720N" ≈ "Sony WH-CH720N Wireless"). */
function namesMatch(a: string, b: string): boolean {
  const [short, long] = tokens(a).length <= tokens(b).length ? [a, b] : [b, a];
  const st = tokens(short);
  const lk = modelKey(long);
  return st.length >= 2 && st.every((t) => lk.includes(t));
}

/** Whether a fetched product is the discovered model. */
export function recordMatchesModel(record: ProductRecord, name: string): boolean {
  const haystack = modelKey(`${record.brand ?? ""} ${record.name} ${record.model ?? ""}`);
  const ts = tokens(name);
  return ts.length >= 2 && ts.every((t) => haystack.includes(t));
}

/** Whether a search result title is likely about the discovered model. */
export function titleMentionsModel(title: string, name: string): boolean {
  const ts = tokens(name);
  const t = modelKey(title);
  return ts.length > 0 && ts.every((x) => t.includes(x));
}
