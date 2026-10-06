/**
 * Server-side configuration. Secrets are read from the environment only and are
 * never sent to the browser or included in deliverables.
 */
import fs from "node:fs";
import path from "node:path";

/** Minimal .env loader (no dependency). Existing env vars win. */
function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

export const config = {
  port: num("PORT", 8787),
  host: process.env.HOST || "127.0.0.1",

  /** Live product search. "auto" uses the first provider with a key: brave, tavily, serper, openai. */
  search: {
    provider: (process.env.CHOOVIO_SEARCH_PROVIDER || "auto").toLowerCase(),
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
    tavilyApiKey: process.env.TAVILY_API_KEY || "",
    serperApiKey: process.env.SERPER_API_KEY || "",
  },
  /** OpenAI API key — optional; improves intent parsing and page extraction, and can power search. */
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  llmEnabled: Boolean(process.env.OPENAI_API_KEY) && !bool("CHOOVIO_DISABLE_LLM", false),
  model: process.env.CHOOVIO_MODEL || "gpt-6-luna",
  llmEffort: (process.env.CHOOVIO_LLM_EFFORT || "low") as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",

  /** Allow demo mode (fixture data, clearly labeled). */
  demoAllowed: bool("CHOOVIO_ALLOW_DEMO", true),

  maxProducts: 5,
  researchDeadlineMs: num("CHOOVIO_RESEARCH_DEADLINE_MS", 240_000), // leave headroom under the 5-minute SLA
  fetchTimeoutMs: num("CHOOVIO_FETCH_TIMEOUT_MS", 12_000),
  searchTimeoutMs: num("CHOOVIO_SEARCH_TIMEOUT_MS", 20_000),

  /** Affiliate tag parameters to append to retailer links, keyed by hostname. Disclosed whenever used. */
  affiliateTags: parseAffiliateTags(process.env.CHOOVIO_AFFILIATE_TAGS || ""),

  acp: {
    offeringName: "Shopping Comparison",
    priceUsdc: num("CHOOVIO_PRICE_USDC", 0.5),
    slaMinutes: num("CHOOVIO_SLA_MINUTES", 5),
    /** Path to acp CLI JS entry; defaults to the globally installed package. */
    cliPath: process.env.ACP_CLI_PATH || "",
    eventsFile: process.env.CHOOVIO_EVENTS_FILE || path.resolve(process.cwd(), ".acp", "events.jsonl"),
    stateFile: process.env.CHOOVIO_STATE_FILE || path.resolve(process.cwd(), ".acp", "jobs.json"),
    drainIntervalMs: num("CHOOVIO_DRAIN_INTERVAL_MS", 5_000),
  },

  /** Pay-per-request HTTP API (x402). Off unless CHOOVIO_X402_PAY_TO is set. */
  x402: {
    payTo: process.env.CHOOVIO_X402_PAY_TO || "",
    /** USD price per comparison, paid in USDC. Same as the ACP price unless overridden. */
    priceUsd: num("CHOOVIO_X402_PRICE_USD", num("CHOOVIO_PRICE_USDC", 0.5)),
    /** "base-sepolia" (testnet, default), "base" (real USDC), or any CAIP-2 id. */
    network: x402Network(process.env.CHOOVIO_X402_NETWORK || "base-sepolia"),
    /** No-signup facilitators: x402.org for testnet, PayAI for Base mainnet. */
    facilitatorUrl: process.env.CHOOVIO_X402_FACILITATOR_URL || (x402Network(process.env.CHOOVIO_X402_NETWORK || "base-sepolia") === "eip155:8453" ? "https://facilitator.payai.network" : "https://x402.org/facilitator"),
    /** Optional bearer token for facilitators that require auth. */
    facilitatorToken: process.env.CHOOVIO_X402_FACILITATOR_TOKEN || "",
    /** Research budget for one paid HTTP request; callers are waiting on the connection. */
    deadlineMs: num("CHOOVIO_X402_DEADLINE_MS", 150_000),
    /** Parallel paid comparisons; extra callers get 503 before paying. */
    maxConcurrent: num("CHOOVIO_X402_MAX_CONCURRENT", 4),
    /** Public base URL used in the payment's resource info, e.g. https://api.choovio.com */
    publicUrl: (process.env.CHOOVIO_PUBLIC_URL || "").replace(/\/+$/, ""),
  },
};

function x402Network(raw: string): `${string}:${string}` {
  const aliases: Record<string, `${string}:${string}`> = { base: "eip155:8453", "base-mainnet": "eip155:8453", "base-sepolia": "eip155:84532" };
  const v = raw.trim().toLowerCase();
  if (aliases[v]) return aliases[v];
  if (/^[a-z0-9-]+:[a-z0-9-]+$/i.test(v)) return v as `${string}:${string}`;
  throw new Error(`Unknown CHOOVIO_X402_NETWORK "${raw}" (use base, base-sepolia or a CAIP-2 id like eip155:8453)`);
}

/** Format: "amazon.com=tag=choovio-20,bestbuy.com=ref=abc" */
function parseAffiliateTags(raw: string): Record<string, { param: string; value: string }> {
  const out: Record<string, { param: string; value: string }> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, param, value] = entry.split("=");
    if (host && param && value) out[host.toLowerCase()] = { param, value };
  }
  return out;
}

export function credentialStatus() {
  return {
    liveSearch: Boolean(liveSearchProviderName()),
    llm: config.llmEnabled,
    demoAllowed: config.demoAllowed,
  };
}

type SearchProviderName = "brave" | "tavily" | "serper" | "openai";

/** Search provider that live search will use first, or null when it is off. */
export function liveSearchProviderName(): SearchProviderName | null {
  return liveSearchProviderNames()[0] ?? null;
}

/**
 * Search providers in the order live search tries them. "auto" lists every
 * configured provider (brave, tavily, serper, openai) so a failure falls through
 * to the next; an explicit choice uses only that provider.
 */
export function liveSearchProviderNames(): SearchProviderName[] {
  const keys = { brave: config.search.braveApiKey, tavily: config.search.tavilyApiKey, serper: config.search.serperApiKey, openai: config.openaiApiKey };
  const p = config.search.provider;
  if (p === "none") return [];
  if (p === "auto") return (Object.keys(keys) as SearchProviderName[]).filter((k) => keys[k]);
  if (!(p in keys)) throw new Error(`Unknown CHOOVIO_SEARCH_PROVIDER "${p}" (use auto, brave, tavily, serper, openai or none)`);
  return keys[p as SearchProviderName] ? [p as SearchProviderName] : [];
}
