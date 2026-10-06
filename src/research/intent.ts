/**
 * Turns a natural-language shopping request into a structured ShoppingRequest
 * and works out which questions are still worth asking.
 *
 * Deterministic and dependency-free; the optional LLM step (llm.ts) may refine
 * the result but is never required.
 */
import type { ClarifyingQuestion, Dimensions, RequestKind, ShoppingRequest } from "../types.js";

export const COUNTRIES: Record<string, { code: string; currency: string; names: string[] }> = {
  US: { code: "US", currency: "USD", names: ["united states", "usa", "u.s.", "us", "america"] },
  GB: { code: "GB", currency: "GBP", names: ["united kingdom", "uk", "u.k.", "britain", "great britain", "england", "scotland", "wales"] },
  CA: { code: "CA", currency: "CAD", names: ["canada"] },
  AU: { code: "AU", currency: "AUD", names: ["australia"] },
  NZ: { code: "NZ", currency: "NZD", names: ["new zealand"] },
  IE: { code: "IE", currency: "EUR", names: ["ireland"] },
  DE: { code: "DE", currency: "EUR", names: ["germany", "deutschland"] },
  FR: { code: "FR", currency: "EUR", names: ["france"] },
  ES: { code: "ES", currency: "EUR", names: ["spain"] },
  IT: { code: "IT", currency: "EUR", names: ["italy"] },
  NL: { code: "NL", currency: "EUR", names: ["netherlands", "holland"] },
  IN: { code: "IN", currency: "INR", names: ["india"] },
  JP: { code: "JP", currency: "JPY", names: ["japan"] },
  SG: { code: "SG", currency: "SGD", names: ["singapore"] },
  AE: { code: "AE", currency: "AED", names: ["uae", "united arab emirates", "dubai"] },
};

const TLD_COUNTRY: Record<string, string> = {
  "co.uk": "GB", uk: "GB", ca: "CA", "com.au": "AU", au: "AU", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL",
  ie: "IE", in: "IN", "co.in": "IN", "co.jp": "JP", jp: "JP", sg: "SG", "com.sg": "SG", ae: "AE", "co.nz": "NZ", nz: "NZ",
};

const SYMBOL_CURRENCY: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };
const WORD_CURRENCY: Record<string, string> = {
  usd: "USD", dollars: "USD", dollar: "USD", bucks: "USD", eur: "EUR", euro: "EUR", euros: "EUR", gbp: "GBP", pounds: "GBP",
  pound: "GBP", quid: "GBP", cad: "CAD", aud: "AUD", nzd: "NZD", inr: "INR", rupees: "INR", jpy: "JPY", yen: "JPY", sgd: "SGD", aed: "AED",
};

const PREFERENCE_WORDS = [
  "comfortable", "comfort", "quiet", "silent", "lightweight", "light", "compact", "portable", "wireless", "wired", "durable",
  "waterproof", "water-resistant", "noise cancelling", "noise-cancelling", "anc", "long battery", "battery life", "fast charging",
  "energy efficient", "eco", "cordless", "bagless", "pet hair", "large capacity", "small", "easy to use", "easy to clean",
  "repairable", "warranty", "stylish", "kid-friendly", "ergonomic", "microphone", "mic", "bluetooth", "usb-c", "budget",
];

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

function parseAmount(s: string): number {
  return Number(s.replace(/[,\s]/g, ""));
}

const CUR = String.raw`(?:([$€£¥₹])\s*)?`;
const AMT = String.raw`(\d{1,3}(?:[,\s]\d{3})+|\d+(?:\.\d{1,2})?)`;
const CUR_WORD = String.raw`(?:\s*(usd|dollars?|bucks|eur|euros?|gbp|pounds?|quid|cad|aud|nzd|inr|rupees|jpy|yen|sgd|aed))?`;

export function parseBudget(text: string): { budget: ShoppingRequest["budget"]; currency: string | null } {
  const t = text.toLowerCase();
  const curOf = (sym?: string, word?: string): string | null =>
    (sym && (SYMBOL_CURRENCY[sym] ?? (sym === "$" ? "USD" : null))) || (word && WORD_CURRENCY[word]) || null;

  const range = new RegExp(String.raw`(?:between\s+)?${CUR}${AMT}${CUR_WORD}\s*(?:-|–|to|and)\s*${CUR}${AMT}${CUR_WORD}`, "i").exec(t);
  if (range && (range[1] || range[3] || range[4] || range[6] || /between|budget/.test(t))) {
    const min = parseAmount(range[2]!);
    const max = parseAmount(range[5]!);
    if (max > min) return { budget: { min, max }, currency: curOf(range[1] ?? range[4], range[3] ?? range[6]) };
  }
  const capRe = new RegExp(
    String.raw`(?:under|below|less than|no more than|max(?:imum)?|up to|within|budget(?: of| is)?|at most|cheaper than|<)\s*:?\s*${CUR}${AMT}${CUR_WORD}`,
    "i",
  );
  const cap = capRe.exec(t);
  if (cap) return { budget: { max: parseAmount(cap[2]!) }, currency: curOf(cap[1], cap[3]) };
  const around = new RegExp(String.raw`(?:around|about|roughly|~)\s*${CUR}${AMT}${CUR_WORD}`, "i").exec(t);
  if (around) {
    const v = parseAmount(around[2]!);
    return { budget: { max: Math.round(v * 1.1 * 100) / 100 }, currency: curOf(around[1], around[3]) };
  }
  // Bare currency amount like "$50 gift" — treat as a cap only with a currency marker.
  const bare = new RegExp(String.raw`([$€£¥₹])\s*${AMT}|${AMT}\s*(usd|dollars|eur|euros|gbp|pounds|cad|aud|inr|jpy)\b`, "i").exec(t);
  if (bare) {
    const amount = parseAmount((bare[2] ?? bare[3])!);
    return { budget: { max: amount }, currency: curOf(bare[1], bare[4]) };
  }
  return { budget: null, currency: null };
}

export function parseCountry(text: string): string | null {
  // Upper-case codes ("US", "UK", "USA") are unambiguous — unlike the pronoun "us".
  // Limited to codes that aren't common English words when shouted ("IT", "IN", "CA"…).
  const upper = /(?:^|[^A-Za-z])(USA|US|UK|GB)(?![A-Za-z])/.exec(text);
  if (upper) return upper[1] === "USA" ? "US" : upper[1] === "UK" ? "GB" : upper[1]!;
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}.\s]/gu, " ")} `;
  for (const c of Object.values(COUNTRIES)) {
    for (const name of c.names) {
      // Short codes like "us"/"uk" need a locating preposition to avoid matching "us" the pronoun.
      if (name.length <= 4) {
        if (new RegExp(String.raw`\b(in|to|for|from|ship(?:ping)? to|deliver(?:y|ed)? to|based in)\s+(the\s+)?${name.replace(/\./g, "\\.")}(?=[\s.])`).test(t)) return c.code;
      } else if (t.includes(` ${name} `) || t.includes(` ${name}.`)) {
        return c.code;
      }
    }
  }
  return null;
}

export function countryFromUrl(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const parts = host.split(".");
    const two = parts.slice(-2).join(".");
    return TLD_COUNTRY[two] ?? TLD_COUNTRY[parts[parts.length - 1]!] ?? null;
  } catch {
    return null;
  }
}

export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^[A-Za-z]{2}$/.test(s)) {
    const code = s.toUpperCase() === "UK" ? "GB" : s.toUpperCase();
    return code;
  }
  return parseCountry(`in ${s}`);
}

export function defaultCurrency(country: string | null): string | null {
  return country ? (COUNTRIES[country]?.currency ?? null) : null;
}

function detectKind(text: string, urls: string[]): RequestKind {
  const t = text.toLowerCase();
  if (/\b(fit|fits|fitting|clearance|space|alcove|cabinet|cupboard|niche|cm|mm|inch(es)?|")\b/.test(t) && /\b(fit|space|room|alcove|niche|clearance)\b/.test(t))
    return "fit_check";
  if (/\b(deal|discount(ed)?|sale|bargain|worth (it|the money)|good price|price drop|markdown|black friday)\b/.test(t)) return "deal_check";
  if (/\b(gift|present|birthday|christmas|anniversary|for my (dad|mom|mum|father|mother|wife|husband|partner|friend|son|daughter|brother|sister|boss))\b/.test(t))
    return "gift";
  if (urls.length >= 1 && /\b(compare|vs\.?|versus|which (one|is better)|these)\b/.test(t)) return "compare_links";
  if (urls.length >= 2) return "compare_links";
  return "search";
}

export function parseDimensions(text: string): Dimensions | undefined {
  const t = text.toLowerCase();
  const toCm = (v: number, unit: string): number => {
    if (unit === "mm") return v / 10;
    if (unit === "m") return v * 100;
    if (unit.startsWith("in") || unit === '"') return Math.round(v * 2.54 * 10) / 10;
    return v;
  };
  const triple = /(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(cm|mm|in(?:ch(?:es)?)?|"|m)?/.exec(t);
  if (triple) {
    const unit = triple[4] ?? "cm";
    return { widthCm: toCm(Number(triple[1]), unit), depthCm: toCm(Number(triple[2]), unit), heightCm: toCm(Number(triple[3]), unit) };
  }
  const dims: Dimensions = {};
  const each = /(\d+(?:\.\d+)?)\s*(cm|mm|in(?:ch(?:es)?)?|")\s*(wide|width|deep|depth|high|height|tall)/g;
  let m: RegExpExecArray | null;
  while ((m = each.exec(t))) {
    const v = toCm(Number(m[1]), m[2]!);
    if (/wid/.test(m[3]!)) dims.widthCm = v;
    else if (/dep|deep/.test(m[3]!)) dims.depthCm = v;
    else dims.heightCm = v;
  }
  return Object.keys(dims).length ? dims : undefined;
}

function extractPreferences(text: string): { preferences: string[]; mustHave: string[] } {
  const t = text.toLowerCase();
  const preferences = PREFERENCE_WORDS.filter((w) => new RegExp(String.raw`\b${w.replace(/[-\s]/g, "[-\\s]")}\b`).test(t));
  const purpose = /\bfor\s+([a-z][a-z\s'-]{3,60}?)(?:[,.;!?]|$|\s+(?:under|below|in|with|that|and)\b)/.exec(t);
  if (purpose && !/^(my|a|an|the)\s+(dad|mom|mum|father|mother|wife|husband|partner|friend)\b/.test(purpose[1]!)) {
    preferences.push(purpose[1]!.trim());
  }
  const mustHave: string[] = [];
  const must = /\b(?:must have|must be|needs? to (?:have|be)|has to (?:have|be)|requires?)\s+([a-z0-9][a-z0-9\s-]{2,40}?)(?:[,.;!?]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = must.exec(t))) mustHave.push(m[1]!.trim());
  return { preferences: [...new Set(preferences)], mustHave };
}

function cleanQuery(text: string, urls: string[]): string {
  let q = text;
  for (const u of urls) q = q.replace(u, " ");
  q = q
    .replace(/\b(find|search|look(?:ing)? for|recommend|suggest|show me|i need|i want|can you|please|help me (?:find|choose|pick))\b/gi, " ")
    .replace(/\b(under|below|less than|up to|max(?:imum)?|budget(?: of)?|around|about|between)\s*[$€£¥₹]?\s*\d[\d,.]*(\s*(?:-|to|and)\s*[$€£¥₹]?\s*\d[\d,.]*)?\s*(usd|dollars?|eur|euros?|gbp|pounds?)?/gi, " ")
    .replace(/\b(in|to|for)\s+the\s+(us|uk|usa)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, "")
    .trim();
  return q;
}

export interface ParseInput {
  text: string;
  urls?: string[];
  budget?: number | { min?: number; max: number } | null;
  currency?: string | null;
  country?: string | null;
  preferences?: string[];
}

export function parseRequest(input: ParseInput): ShoppingRequest {
  const text = input.text ?? "";
  const urls = [...new Set([...(input.urls ?? []), ...extractUrls(text)])];
  const parsedBudget = parseBudget(text);
  const explicitBudget =
    typeof input.budget === "number" ? { max: input.budget } : input.budget && input.budget.max > 0 ? input.budget : null;
  const country =
    normalizeCountry(input.country) ?? parseCountry(text) ?? (urls.length ? urls.map(countryFromUrl).find(Boolean) ?? null : null);
  let currency = input.currency?.toUpperCase() || parsedBudget.currency;
  // "$" is ambiguous; prefer the delivery country's dollar currency.
  if (currency === "USD" && !input.currency && country && ["CA", "AU", "NZ", "SG"].includes(country) && !/\busd\b/i.test(text)) {
    currency = defaultCurrency(country);
  }
  currency = currency || defaultCurrency(country);
  const { preferences, mustHave } = extractPreferences(text);
  return {
    query: cleanQuery(text, urls),
    urls,
    kind: detectKind(text, urls),
    budget: explicitBudget ?? parsedBudget.budget,
    currency: currency ?? null,
    country,
    preferences: [...new Set([...(input.preferences ?? []), ...preferences])],
    mustHave,
    space: parseDimensions(text),
  };
}

/** Only ask what materially changes the recommendation. Never asks for an address. */
export function missingQuestions(req: ShoppingRequest): ClarifyingQuestion[] {
  const qs: ClarifyingQuestion[] = [];
  if (!req.query && req.urls.length === 0) {
    qs.push({ field: "query", question: "What are you shopping for? A short description or a product link is perfect." });
    return qs;
  }
  if (!req.country) {
    qs.push({
      field: "country",
      question: "Which country should it be delivered to? (Just the country — I don't need an address.) Prices, stock and shipping all depend on it.",
    });
  }
  const needsBudget = req.kind === "search" || req.kind === "gift";
  if (needsBudget && !req.budget) {
    qs.push({ field: "budget", question: "What's the most you'd like to spend?" });
  }
  if (req.kind === "gift" && req.preferences.length === 0) {
    qs.push({ field: "use", question: "What do they enjoy, or what would they actually use day to day?" });
  } else if (req.kind === "search" && req.preferences.length === 0 && req.query.split(/\s+/).length <= 2) {
    qs.push({ field: "use", question: `What will you mainly use the ${req.query || "product"} for? Anything it must have?` });
  }
  if (req.kind === "fit_check" && !req.space) {
    qs.push({ field: "space", question: "What are the width, depth and height of the space (in cm or inches)? Include any door or hose clearance you need." });
  }
  return qs.slice(0, 3);
}
