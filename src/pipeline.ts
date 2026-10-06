/**
 * Choovio research pipeline:
 *   request → intent → candidates (links or search) → safe fetch → extraction
 *   → (optional) LLM insights → merge & conflict check → rank → recommendation
 */
import { config } from "./config.js";
import { mergeRecords, sameProduct } from "./compare/merge.js";
import { rankProducts } from "./compare/score.js";
import { buildFromPage, hostOf, isIndependentReviewHost } from "./extraction/product.js";
import { buildRecommendation } from "./recommend/build.js";
import type { PageFetcher } from "./research/fetcher.js";
import { missingQuestions, parseRequest, type ParseInput } from "./research/intent.js";
import type { FxRates, FxSource } from "./research/fx.js";
import type { LlmHelper } from "./research/llm.js";
import { discoverModels, recordMatchesModel, titleMentionsModel, type DiscoveredModel, type RoundupPage } from "./research/discover.js";
import { isGuidePage, isLikelyShopPage, reviewQuery, type SearchProvider } from "./research/search.js";
import { htmlToText } from "./security/untrusted.js";
import { parseExternalUrl } from "./security/url.js";
import type { ClarifyingQuestion, ProductRecord, Recommendation, ShoppingRequest, Source } from "./types.js";

export interface PipelineDeps {
  fetcher: PageFetcher;
  search?: SearchProvider | null;
  llm?: LlmHelper | null;
  /** Exchange rates for budget checks when prices aren't in the budget currency. Omitted → no conversion. */
  fx?: FxSource | null;
  now?: () => Date;
  deadlineMs?: number;
  log?: (msg: string) => void;
}

export type PipelineResult =
  | { type: "questions"; request: ShoppingRequest; questions: ClarifyingQuestion[] }
  | { type: "recommendation"; recommendation: Recommendation };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function withDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(`Out of time before ${what}`));
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out during ${what}`)), remaining).unref?.())]);
}

export async function prepareRequest(input: ParseInput | ShoppingRequest, llm?: LlmHelper | null): Promise<ShoppingRequest> {
  if ("kind" in input) return input;
  let req = parseRequest(input);
  if (llm && input.text && req.urls.length === 0) {
    try {
      req = { ...req, ...(await llm.refineRequest(input.text, req)) };
    } catch {
      // LLM is optional; keep the deterministic parse.
    }
  }
  return req;
}

export async function runComparison(input: ParseInput | ShoppingRequest, deps: PipelineDeps): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const deadline = Date.now() + (deps.deadlineMs ?? config.researchDeadlineMs);
  const request = await prepareRequest(input, deps.llm);

  const questions = missingQuestions(request);
  if (questions.length) return { type: "questions", request, questions };

  const checkedAt = now().toISOString();
  const failures: { url: string; reason: string }[] = [];
  const notes: string[] = [];

  // 1. Candidate pages
  let candidates: string[] = [];
  for (const raw of request.urls.slice(0, config.maxProducts)) {
    try {
      candidates.push(parseExternalUrl(raw).href);
    } catch (e) {
      failures.push({ url: raw, reason: (e as Error).message });
    }
  }
  if (request.urls.length > config.maxProducts) notes.push(`Only the first ${config.maxProducts} links were compared`);

  const searchSnippets = new Map<string, string>();
  let guideUrls: string[] = [];
  const where = request.country ? ` ${request.country === "GB" ? "UK" : request.country}` : "";
  // The LLM-refined query often already names the country ("… UK"); don't repeat it.
  const whereIfMissing = where && !new RegExp(`\\b${where.trim()}\\b`, "i").test(request.query) ? where : "";
  if (!candidates.length && request.urls.length === 0) {
    if (!deps.search) {
      return {
        type: "recommendation",
        recommendation: buildRecommendation({
          request,
          ranked: [],
          dataMode: deps.fetcher.mode,
          checkedAt,
          failures,
          notes: ["Live product search isn't configured (no search provider key set). Paste product links, or try demo mode."],
        }),
      };
    }
    const q = `${request.query} buy${whereIfMissing}`;
    try {
      const results = await withDeadline(deps.search.search(q, { country: request.country, count: 20 }), deadline, "search");
      for (const r of results) searchSnippets.set(r.url, r.snippet);
      candidates = results.map((r) => r.url).filter((u) => isLikelyShopPage(u) && !isGuidePage(u) && isFetchable(u));
      guideUrls = guidesFirst(results.map((r) => r.url).filter((u) => isGuidePage(u) && isFetchable(u)));
      // Prefer diversity: at most two pages per site.
      const perHost = new Map<string, number>();
      candidates = candidates.filter((u) => {
        const h = hostOf(u);
        perHost.set(h, (perHost.get(h) ?? 0) + 1);
        return perHost.get(h)! <= 2;
      }).slice(0, 10);
    } catch (e) {
      notes.push(`Search failed: ${(e as Error).message}`);
    }
  }

  // 2. Fetch & extract
  const records: ProductRecord[] = [];
  const pageTexts = new Map<string, string>();
  // Search-found pages with no priced product (category/collection listings): mined for product names below.
  const listingPages: RoundupPage[] = [];
  const fetchInto = (urls: string[]) => mapLimit(urls, 4, async (url) => {
    if (records.length >= config.maxProducts * 2) return;
    try {
      const page = await withDeadline(deps.fetcher.fetch(url), deadline, `fetching ${hostOf(url)}`);
      const built = buildFromPage({ url: page.finalUrl, html: page.html, checkedAt: now().toISOString(), dataMode: deps.fetcher.mode, country: request.country });
      pageTexts.set(page.finalUrl, built.pageText);
      if (!request.urls.length && !built.products.some((p) => p.offers.length || p.model || p.gtin)) {
        listingPages.push({ url: page.finalUrl, html: page.html, text: built.pageText });
        return;
      }
      if (!built.products.length) {
        // Only report as a failure when the user asked for this page explicitly.
        if (request.urls.length) failures.push({ url, reason: "No product information found on the page" });
        return;
      }
      if (built.pageKind === "independent_review" && request.urls.length) {
        notes.push(`${hostOf(url)} is a review site, so it was used as review evidence rather than a place to buy`);
      }
      records.push(...built.products);
    } catch (e) {
      const reason = (e as Error).message;
      log(`fetch failed ${url}: ${reason}`);
      if (request.urls.length) failures.push({ url, reason });
    }
  });
  await fetchInto(candidates);

  // 2b. Searches like "best X under $Y" or gift searches mostly return roundups, gift
  // guides and category pages. When too few priced products turned up, search for
  // the specific products those pages recommend or list.
  let discovered: DiscoveredModel[] = [];
  if (deps.search && !request.urls.length && records.filter((r) => r.offers.length).length < 3 && Date.now() < deadline - 90_000) {
    try {
      if (!guideUrls.length) {
        const results = await withDeadline(deps.search.search(`best ${request.query}`, { country: request.country, count: 10 }), deadline - 60_000, "guide search");
        guideUrls = guidesFirst(results.map((r) => r.url).filter((u) => isGuidePage(u) && isFetchable(u)));
      }
      const guides = (
        await mapLimit(guideUrls.slice(0, 3), 3, async (url): Promise<RoundupPage | null> => {
          try {
            const page = await withDeadline(deps.fetcher.fetch(url), deadline - 60_000, `fetching ${hostOf(url)}`);
            return { url: page.finalUrl, html: page.html, text: htmlToText(page.html) };
          } catch (e) {
            log(`guide fetch failed ${url}: ${(e as Error).message}`);
            return null;
          }
        })
      ).filter((p): p is RoundupPage => p !== null);
      const pages = [...guides, ...listingPages].slice(0, 4);
      discovered = await withDeadline(discoverModels(pages, deps.llm, request.query), deadline - 60_000, "reading roundups");
      log(`discovered models: ${discovered.map((m) => m.name).join(", ") || "none"}`);
      const found = await mapLimit(discovered, 3, async (m) => {
        try {
          const results = await withDeadline(deps.search!.search(`${m.name} buy${where}`, { country: request.country, count: 10 }), deadline - 60_000, "model search");
          return results
            .filter((r) => isLikelyShopPage(r.url) && isFetchable(r.url))
            .sort((a, b) => Number(titleMentionsModel(b.title, m.name)) - Number(titleMentionsModel(a.title, m.name)))
            .slice(0, 2)
            .map((r) => r.url);
        } catch (e) {
          log(`model search failed for ${m.name}: ${(e as Error).message}`);
          return [];
        }
      });
      const seen = new Set(candidates);
      await fetchInto(found.flat().filter((u) => !seen.has(u) && Boolean(seen.add(u))).slice(0, 10));
    } catch (e) {
      log(`discovery failed: ${(e as Error).message}`);
    }
  }

  // Review-site pages contribute evidence to matching products, never stand alone as offers.
  const shopRecords = records.filter((r) => r.offers.length || !r.reviews.some((x) => x.kind === "independent_review"));
  const reviewRecords = records.filter((r) => !shopRecords.includes(r));

  // 3. Optional LLM insights (specs/complaints validated against the page text)
  if (deps.llm) {
    await mapLimit(shopRecords.slice(0, config.maxProducts), 3, async (rec) => {
      const url = rec.offers[0]?.source.url ?? rec.specs[0]?.source.url;
      const text = url ? pageTexts.get(url) : undefined;
      if (!url || !text || Date.now() > deadline - 30_000) return;
      try {
        const ins = await withDeadline(deps.llm!.extractInsights(url, text, rec.name), deadline - 20_000, "page analysis");
        const kind = rec.specs[0]?.source.kind ?? "retailer_listing";
        const src: Source = { url, kind, checkedAt: now().toISOString(), title: rec.offers[0]?.source.title };
        for (const s of ins.specs) if (!rec.specs.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) rec.specs.push({ name: s.name, value: s.value, source: src });
        for (const c of ins.complaints) rec.complaints.push({ text: c.text, quote: c.quote, source: { ...src, kind: "retailer_rating" } });
      } catch (e) {
        log(`insights failed: ${(e as Error).message}`);
      }
    });
  }

  // 4. Independent review lookup for the leading candidates (live search only)
  let merged = mergeRecords(shopRecords);
  for (const rr of reviewRecords) {
    const match = merged.find((m) => sameProduct(m, rr));
    if (match) {
      match.reviews.push(...rr.reviews);
      match.specs.push(...rr.specs);
      match.complaints.push(...rr.complaints);
    } else if (request.urls.length) {
      notes.push(`Review page ${hostOf(rr.specs[0]?.source.url ?? rr.reviews[0]?.url ?? "")} didn't match any product being compared`);
    }
  }
  merged = mergeRecords(merged);
  let fx: FxRates | null = null;
  const budgetCurrency = request.currency;
  if (deps.fx && budgetCurrency && merged.some((r) => r.offers.some((o) => o.price && o.price.currency !== budgetCurrency))) {
    fx = await deps.fx(budgetCurrency).catch(() => null);
    if (!fx) notes.push(`Some prices aren't in ${budgetCurrency} and exchange rates couldn't be loaded, so their budget fit is unconfirmed`);
  }
  for (const m of discovered) {
    for (const rec of merged.filter((r) => recordMatchesModel(r, m.name))) {
      for (const { url, quote } of m.mentions) {
        if (rec.reviews.some((r) => r.url === url)) continue;
        rec.reviews.push({
          kind: "independent_review",
          summary: quote ? `${hostOf(url)} recommends it: "${quote.slice(0, 200)}"` : `Listed in ${hostOf(url)}'s roundup (open it for the full verdict)`,
          url,
          source: { url, kind: "independent_review", checkedAt: now().toISOString() },
        });
      }
    }
  }
  if (deps.search && Date.now() < deadline - 45_000) {
    const preliminary = rankProducts(merged, request, fx).slice(0, 3);
    await mapLimit(preliminary, 3, async (sp) => {
      try {
        const results = await withDeadline(
          deps.search!.search(reviewQuery(sp.product.name, sp.product.brand, sp.product.model), { country: request.country, count: 10 }),
          deadline - 30_000,
          "review search",
        );
        const hit = results.find((r) => isIndependentReviewHost(r.url) && mentions(r.title + " " + r.snippet, sp.product));
        if (hit) {
          sp.product.reviews.push({
            kind: "search_snippet",
            summary: `${hostOf(hit.url)}: "${hit.snippet.slice(0, 200)}" (search snippet — open the review for the full verdict)`,
            url: hit.url,
            source: { url: hit.url, title: hit.title, kind: "search_snippet", checkedAt: now().toISOString() },
          });
        }
      } catch {
        /* optional */
      }
    });
    merged = mergeRecords(merged);
  }

  if (Date.now() > deadline) notes.push("Research hit the time limit; some pages may not have been checked");
  const ranked = rankProducts(merged, request, fx);
  const recommendation = buildRecommendation({ request, ranked, dataMode: deps.fetcher.mode, checkedAt, failures, notes });
  return { type: "recommendation", recommendation };
}

/** Independent review sites before other guides, at most three. */
function guidesFirst(urls: string[]): string[] {
  return [...urls.filter(isIndependentReviewHost), ...urls.filter((u) => !isIndependentReviewHost(u))].slice(0, 3);
}

function isFetchable(url: string): boolean {
  try {
    parseExternalUrl(url);
    return true;
  } catch {
    return false;
  }
}

function mentions(text: string, p: ProductRecord): boolean {
  const t = text.toLowerCase();
  if (p.model && t.includes(p.model.toLowerCase())) return true;
  const words = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
  return words.length > 0 && words.filter((w) => t.includes(w)).length >= Math.min(3, words.length);
}
