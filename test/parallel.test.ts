import { describe, expect, it } from "vitest";
import { DemoSearchProvider, demoPages } from "../src/demo/fixtures.js";
import { runComparison, type ProgressUpdate } from "../src/pipeline.js";
import { FixtureFetcher } from "../src/research/fetcher.js";
import { ParallelSearchProvider, SearchHttpError, type SearchProvider, type SearchResult } from "../src/research/search.js";

const opts = { country: "US", count: 20 };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lane(name: string, results: SearchResult[] | Error, ms = 0): SearchProvider {
  return {
    name,
    async search() {
      await delay(ms);
      if (results instanceof Error) throw results;
      return results;
    },
  };
}

const r = (url: string): SearchResult => ({ url, title: url, snippet: "" });

describe("ParallelSearchProvider", () => {
  it("hands over each lane's results as soon as that lane answers", async () => {
    const order: string[] = [];
    const p = new ParallelSearchProvider([lane("legacy", [r("https://a.example/1")], 5), lane("openai", [r("https://b.example/1")], 40)]);
    const started = Date.now();
    const arrivals: number[] = [];
    await p.searchEach("q", opts, (name) => {
      order.push(name);
      arrivals.push(Date.now() - started);
    });
    expect(order).toEqual(["legacy", "openai"]);
    expect(arrivals[0]).toBeLessThan(35);
  });

  it("succeeds when one lane fails and throws only when every lane fails", async () => {
    const seen: string[] = [];
    await new ParallelSearchProvider([lane("legacy", new SearchHttpError(401)), lane("openai", [r("https://b.example/1")])]).searchEach("q", opts, (name) => void seen.push(name));
    expect(seen).toEqual(["openai"]);
    await expect(new ParallelSearchProvider([lane("legacy", new SearchHttpError(401)), lane("openai", new SearchHttpError(500))]).searchEach("q", opts, () => {})).rejects.toThrow(
      "legacy: Search API returned HTTP 401; openai: Search API returned HTTP 500",
    );
  });

  it("uses lanes as a fallback chain for single searches", async () => {
    const p = new ParallelSearchProvider([lane("legacy", []), lane("openai", [r("https://b.example/1")])]);
    await expect(p.search("q", opts)).resolves.toEqual([r("https://b.example/1")]);
  });
});

describe("progressive results", () => {
  it("reports products found by the fast lane before the slow lane finishes", async () => {
    const all = await new DemoSearchProvider().search();
    const search = new ParallelSearchProvider([lane("legacy", all.slice(0, 2), 0), lane("openai", all.slice(2), 60)]);
    const updates: ProgressUpdate[] = [];
    const result = await runComparison({ text: "headphones under $100 for long work calls in the US" }, { fetcher: new FixtureFetcher(demoPages()), search, llm: null, onProgress: (u) => updates.push(u) });

    expect(result.type).toBe("recommendation");
    if (result.type !== "recommendation") return;
    expect(updates[0]).toEqual({ stage: "searching", recommendation: null });
    const firstWithProducts = updates.find((u) => u.recommendation?.products.length);
    expect(firstWithProducts).toBeDefined();
    // The interim ranking came before the slow lane's pages were read, so it has fewer products than the final one.
    expect(firstWithProducts!.recommendation!.products.length).toBeLessThan(result.recommendation.products.length);
  });
});
