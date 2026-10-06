/**
 * Search providers (server-side keys). Pick one with CHOOVIO_SEARCH_PROVIDER, or
 * leave it on "auto" to use the first configured: brave, tavily, serper, openai.
 * In "auto", when both a legacy key and OPENAI_API_KEY are set, the main product
 * search runs legacy and AI search in parallel (see ParallelSearchProvider).
 */
import { config, liveSearchProviderNames } from "../config.js";
import { INDEPENDENT_REVIEW_HOSTS, hostOf } from "../extraction/product.js";
import { openaiResponses, reasoningParam } from "./llm.js";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]>;
  /**
   * Optional: runs independent search lanes in parallel and hands each lane's
   * results to `onResults` as soon as that lane finishes. Resolves once every
   * lane (and its callback) is done; throws only when every lane failed.
   */
  searchEach?(query: string, opts: { country: string | null; count?: number }, onResults: (lane: string, results: SearchResult[]) => void | Promise<void>): Promise<void>;
}

export class SearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`Search API returned HTTP ${status}`);
  }
}

/** Timeouts, network errors, rate limits and 5xx are worth one more try. */
export function isTransientSearchError(err: unknown): boolean {
  if (err instanceof SearchHttpError) return err.status === 429 || err.status >= 500;
  const name = (err as Error | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError" || err instanceof TypeError;
}

/**
 * Tries each provider in order: a transient failure is retried once, and any
 * failure or empty result moves on to the next provider (e.g. Tavily often
 * returns nothing with a country filter). Throws only when every provider fails.
 */
export class FallbackSearchProvider implements SearchProvider {
  readonly name: string;
  constructor(
    private readonly providers: SearchProvider[],
    private readonly retryDelayMs = 500,
  ) {
    if (!providers.length) throw new Error("FallbackSearchProvider needs at least one provider");
    this.name = providers.map((p) => p.name).join("+");
  }

  async search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    const failures: string[] = [];
    let empty = false;
    for (const provider of this.providers) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const results = await provider.search(query, opts);
          if (results.length) return results;
          empty = true;
          break;
        } catch (err) {
          if (attempt === 1 && isTransientSearchError(err)) {
            await new Promise((r) => setTimeout(r, this.retryDelayMs));
            continue;
          }
          failures.push(`${provider.name}: ${(err as Error).message}`);
          break;
        }
      }
    }
    if (empty) return [];
    throw new Error(failures.join("; "));
  }
}

/**
 * Legacy search (Brave/Tavily/Serper) and AI search (OpenAI web search) side by
 * side. `searchEach` runs every lane at once so the fast lane's results can be
 * used while the slow one is still working; `search` keeps the cheaper
 * fallback order (first lane first) for follow-up searches.
 */
export class ParallelSearchProvider implements SearchProvider {
  readonly name: string;
  private readonly fallback: FallbackSearchProvider;
  constructor(private readonly lanes: SearchProvider[]) {
    if (!lanes.length) throw new Error("ParallelSearchProvider needs at least one lane");
    this.name = lanes.map((l) => l.name).join(" | ");
    this.fallback = new FallbackSearchProvider(lanes);
  }

  search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    return this.fallback.search(query, opts);
  }

  async searchEach(query: string, opts: { country: string | null; count?: number }, onResults: (lane: string, results: SearchResult[]) => void | Promise<void>): Promise<void> {
    const failures: string[] = [];
    let succeeded = false;
    await Promise.all(
      this.lanes.map(async (lane) => {
        let results: SearchResult[];
        try {
          results = await lane.search(query, opts);
        } catch (err) {
          failures.push(`${lane.name}: ${(err as Error).message}`);
          return;
        }
        succeeded = true;
        await onResults(lane.name, results);
      }),
    );
    if (!succeeded) throw new Error(failures.join("; "));
  }
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave";
  constructor(private readonly apiKey: string = config.search.braveApiKey) {
    if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
  }

  async search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(Math.min(opts.count ?? 20, 20)), safesearch: "moderate" });
    if (opts.country) params.set("country", opts.country.toLowerCase() === "gb" ? "gb" : opts.country.toLowerCase());
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!res.ok) throw new SearchHttpError(res.status);
    const data = (await res.json()) as { web?: { results?: { url?: string; title?: string; description?: string }[] } };
    return (data.web?.results ?? [])
      .filter((r) => typeof r.url === "string")
      .map((r) => ({ url: r.url!, title: stripTags(r.title ?? ""), snippet: stripTags(r.description ?? "") }));
  }
}

/** Tavily — free tier without a card. https://tavily.com */
export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string = config.search.tavilyApiKey) {
    if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  }

  async search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    const body: Record<string, unknown> = { query, max_results: Math.min(opts.count ?? 20, 20), search_depth: "basic", topic: "general" };
    const country = opts.country ? countryName(opts.country) : null;
    let res = await this.post(country ? { ...body, country } : body);
    // Tavily only accepts some country names; retry without the hint rather than fail.
    if (res.status === 400 && country) res = await this.post(body);
    if (!res.ok) throw new SearchHttpError(res.status);
    const data = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[] };
    return (data.results ?? [])
      .filter((r) => typeof r.url === "string")
      .map((r) => ({ url: r.url!, title: stripTags(r.title ?? ""), snippet: stripTags(r.content ?? "").slice(0, 400) }));
  }

  private post(body: Record<string, unknown>) {
    return fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
  }
}

/** Serper (Google results) — free credits without a card. https://serper.dev */
export class SerperSearchProvider implements SearchProvider {
  readonly name = "serper";
  constructor(private readonly apiKey: string = config.search.serperApiKey) {
    if (!apiKey) throw new Error("SERPER_API_KEY is not set");
  }

  async search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    const body: Record<string, unknown> = { q: query, num: Math.min(opts.count ?? 20, 20) };
    if (opts.country) body.gl = opts.country.toLowerCase();
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!res.ok) throw new SearchHttpError(res.status);
    const data = (await res.json()) as { organic?: { link?: string; title?: string; snippet?: string }[] };
    return (data.organic ?? [])
      .filter((r) => typeof r.link === "string")
      .map((r) => ({ url: r.link!, title: stripTags(r.title ?? ""), snippet: stripTags(r.snippet ?? "") }));
  }
}

/**
 * OpenAI web search tool — reuses OPENAI_API_KEY, billed per search call.
 * Only URLs the tool actually retrieved (citations and sources) are used; the
 * model's prose is ignored, and every page is still fetched and verified.
 */
export class OpenAIWebSearchProvider implements SearchProvider {
  readonly name = "openai";
  constructor(private readonly apiKey: string = config.openaiApiKey) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  }

  async search(query: string, opts: { country: string | null; count?: number }): Promise<SearchResult[]> {
    const count = Math.min(opts.count ?? 20, 20);
    const tool: Record<string, unknown> = { type: "web_search" };
    if (opts.country) tool.user_location = { type: "approximate", country: opts.country.toUpperCase() };
    const data = await openaiResponses(
      this.apiKey,
      {
        model: config.model,
        tools: [tool],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        ...reasoningParam(),
        input: `Search the web for: ${query}${opts.country ? ` (shopper is in ${opts.country.toUpperCase()})` : ""}. List up to ${count} distinct relevant pages, citing each one.`,
      },
      90_000,
    );
    const seen = new Map<string, SearchResult>();
    const add = (raw: string | undefined, title = "") => {
      if (!raw) return;
      let url: string;
      try {
        const u = new URL(raw);
        u.searchParams.delete("utm_source");
        url = u.toString();
      } catch {
        return;
      }
      if (!seen.has(url)) seen.set(url, { url, title: stripTags(title), snippet: "" });
    };
    for (const item of data.output ?? []) {
      for (const c of item.content ?? []) for (const a of c.annotations ?? []) if (a.type === "url_citation") add(a.url, a.title);
      for (const src of item.action?.sources ?? []) add(src.url);
    }
    return [...seen.values()].slice(0, count);
  }
}

export function createSearchProvider(): SearchProvider | null {
  const providers = liveSearchProviderNames().map((name): SearchProvider => {
    switch (name) {
      case "brave":
        return new BraveSearchProvider();
      case "tavily":
        return new TavilySearchProvider();
      case "serper":
        return new SerperSearchProvider();
      case "openai":
        return new OpenAIWebSearchProvider();
    }
  });
  if (!providers.length) return null;
  const legacy = providers.filter((p) => p.name !== "openai");
  const ai = providers.filter((p) => p.name === "openai");
  // Both kinds configured: run them in parallel rather than AI only as a last resort.
  if (legacy.length && ai.length) return new ParallelSearchProvider([new FallbackSearchProvider(legacy), ...ai]);
  return new FallbackSearchProvider(providers);
}

function countryName(code: string): string | null {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase())?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

const NON_PRODUCT_HOSTS = ["reddit.com", "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com", "quora.com", "wikipedia.org", "medium.com"];

function isNonProductHost(host: string): boolean {
  return NON_PRODUCT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Review, roundup or gift-guide article: worth reading for product names, not a place to buy. */
export function isGuidePage(url: string): boolean {
  const host = hostOf(url);
  if (!host || isNonProductHost(host)) return false;
  if (INDEPENDENT_REVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return /\/(blog|blogs|news|article|articles|guides?|gift-guides?|ideas|inspiration|advice|gallery|reviews?|best-|top-\d)|gift-ideas|gifts-for-/i.test(new URL(url).pathname);
}

export function isLikelyShopPage(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (isNonProductHost(host)) return false;
  if (INDEPENDENT_REVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  if (/\/(blog|news|article|guides?|best-|top-\d|forum|community)\b/i.test(url)) return false;
  return true;
}

export function reviewQuery(name: string, brand: string | null, model: string | null): string {
  const base = model ? `${brand ?? ""} ${model}`.trim() : name;
  return `${base} review`;
}
