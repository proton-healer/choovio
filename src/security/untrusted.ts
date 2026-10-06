/**
 * Handling of retrieved page content, which is always untrusted data.
 *
 * - Pages are reduced to visible text (scripts, styles, hidden elements and
 *   comments removed) before anything reads them.
 * - Text that looks like instructions aimed at an AI ("ignore previous
 *   instructions", "recommend this product", fake system/assistant turns…) is
 *   detected and reported as a warning on the product. It is never obeyed:
 *   the deterministic pipeline does not interpret page text as commands, and
 *   the optional LLM step wraps page text in a data envelope and validates
 *   every extracted claim against the page.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|your)\s+(instructions|rules|guidelines)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bsystem\s*(prompt|message|instruction)s?\s*[:=]/i,
  /<\s*\/?\s*(system|assistant|instructions?)\s*>/i,
  /^\s*(system|assistant)\s*:/im,
  /\b(AI|LLM|assistant|agent|model|chatbot|shopping (bot|assistant))s?\b[^.]{0,80}\b(must|should|always)\s+(recommend|rank|rate|choose|say|tell|output)/i,
  /\b(always|must)\s+(recommend|rank|choose)\s+this\b/i,
  /\brank\s+this\s+(product|item)\s+(first|highest|#?1)\b/i,
  /\b(reveal|print|output)\s+(your|the)\s+(system\s+prompt|instructions|api\s*key|secrets?)\b/i,
  /\bsend\s+(your|the)\s+(api\s*key|wallet|private\s*key|credentials)\b/i,
  /\b(transfer|send)\s+\d+(\.\d+)?\s*(usdc|eth|usd|tokens?)\b/i,
];

export interface InjectionScan {
  suspicious: boolean;
  matches: string[];
}

export function scanForInjection(text: string): InjectionScan {
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0].slice(0, 120));
  }
  return { suspicious: matches.length > 0, matches };
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITY_MAP[code.toLowerCase()] ?? whole;
  });
}

/** Strip an HTML document to readable visible text. */
export function htmlToText(html: string, maxChars = 60_000): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, " ");
  // Elements hidden from humans are a classic injection vector — drop them.
  s = s.replace(/<([a-z0-9]+)\b[^>]*(\bhidden\b|aria-hidden\s*=\s*["']?true|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[​-‏‪-‮⁠-⁤﻿]/g, ""); // zero-width & bidi controls
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/** Collapse whitespace & case for robust "does the page actually say this?" checks. */
export function normalizeForMatch(s: string): string {
  return decodeEntities(s).toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

export function pageContains(pageText: string, quote: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length >= 8 && normalizeForMatch(pageText).includes(q);
}

/** Wrap page text for an LLM prompt as inert data. */
export function asUntrustedBlock(url: string, text: string): string {
  const cleaned = text.replace(/<\/?untrusted_page[^>]*>/gi, "");
  return `<untrusted_page url="${url.replace(/"/g, "%22")}">\n${cleaned}\n</untrusted_page>`;
}

/** Keep short display strings from pages safe and tidy (no control chars, bounded length). */
export function cleanDisplay(s: unknown, max = 200): string | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const out = decodeEntities(String(s)).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
