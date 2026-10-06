import { describe, expect, it } from "vitest";
import { runComparison } from "../src/pipeline.js";
import { discoverModels, headingCandidates } from "../src/research/discover.js";
import { FixtureFetcher } from "../src/research/fetcher.js";
import { validateRecommended } from "../src/research/llm.js";
import type { SearchProvider, SearchResult } from "../src/research/search.js";
import { page } from "./helpers.js";

const base = { currency: "USD", availability: "InStock" as const, seller: "Shop", returnDays: 30, warrantyYears: 1, rating: [4.5, 200] as [number, number] };

const roundup = (models: string[]) => `<html><head><title>The best headphones under $100</title></head><body>
  <h1>The best headphones under $100</h1>
  <h2>Our top picks</h2>
  ${models.map((m, i) => `<h3>${i + 1}. ${m}</h3><p>The ${m} is comfortable for long calls.</p>`).join("\n")}
  <h2>How we tested</h2><h2>Frequently asked questions</h2>
</body></html>`;

describe("headingCandidates", () => {
  it("keeps model headings and drops section headings", () => {
    const html = roundup(["Sony WH-CH720N", "Anker Soundcore Q20i"]) + "<h2>Best overall: Jabra Evolve2 30</h2><h3>Why you should trust us</h3>";
    expect(headingCandidates(html)).toEqual(["Sony WH-CH720N", "Anker Soundcore Q20i", "Jabra Evolve2 30"]);
  });
});

describe("validateRecommended", () => {
  it("drops names and quotes that are not on the page", () => {
    const text = "Our pick is the Sony WH-CH720N. It is light and comfortable for all-day calls.";
    expect(
      validateRecommended(
        [
          { name: "Sony WH-CH720N", quote: "light and comfortable for all-day calls" },
          { name: "Bose QC Ultra", quote: "light and comfortable for all-day calls" },
          { name: "Sony WH-CH720N", quote: "the best headphones ever made" },
        ],
        text,
      ),
    ).toEqual([{ name: "Sony WH-CH720N", quote: "light and comfortable for all-day calls" }]);
  });
});

describe("discoverModels", () => {
  it("ranks models recommended by more roundups first and merges name variants", async () => {
    const pages = [
      { url: "https://www.rtings.com/a", html: roundup(["Anker Soundcore Q20i", "Sony WH-CH720N"]), text: "" },
      { url: "https://www.soundguys.com/b", html: roundup(["Sony WH-CH720N Wireless", "JLab JBuds Lux"]), text: "" },
    ];
    const models = await discoverModels(pages, null, "headphones");
    expect(models[0]!.name).toBe("Sony WH-CH720N");
    expect(models[0]!.mentions.map((m) => m.url)).toEqual(["https://www.rtings.com/a", "https://www.soundguys.com/b"]);
    expect(models.map((m) => m.name)).toContain("Anker Soundcore Q20i");
  });
});

describe("pipeline discovery", () => {
  const pages: Record<string, string> = {
    "https://www.rtings.com/headphones/best/under-100": roundup(["Sony WH-CH720N", "Anker Soundcore Q20i"]),
    "https://shop.example/c/headphones-under-100": "<html><head><title>Headphones under $100</title></head><body>Category</body></html>",
    "https://shop.example/p/sony-wh-ch720n": page({ ...base, brand: "Sony", name: "Sony WH-CH720N Wireless Headphones", mpn: "WH-CH720N", price: 98 }),
    "https://other.example/p/anker-q20i": page({ ...base, brand: "Anker", name: "Anker Soundcore Q20i", mpn: "Q20i", price: 49 }),
  };
  const queries: string[] = [];
  const search: SearchProvider = {
    name: "fake",
    async search(q): Promise<SearchResult[]> {
      queries.push(q);
      if (/WH-CH720N/.test(q)) return [{ url: "https://shop.example/p/sony-wh-ch720n", title: "Sony WH-CH720N", snippet: "" }];
      if (/Q20i/.test(q)) return [{ url: "https://other.example/p/anker-q20i", title: "Anker Soundcore Q20i", snippet: "" }];
      if (/review$/.test(q)) return [];
      return [
        { url: "https://www.rtings.com/headphones/best/under-100", title: "The best headphones under $100", snippet: "" },
        { url: "https://shop.example/c/headphones-under-100", title: "Headphones under $100", snippet: "" },
      ];
    },
  };

  it("finds priced products via the models a roundup recommends", async () => {
    const r = await runComparison({ text: "comfortable headphones under $100 for long work calls in the US" }, { fetcher: new FixtureFetcher(pages), search, llm: null });
    if (r.type !== "recommendation") throw new Error("expected a recommendation");
    const names = r.recommendation.products.map((p) => p.product.name);
    expect(names).toEqual(expect.arrayContaining(["Sony WH-CH720N Wireless Headphones", "Anker Soundcore Q20i"]));
    expect(r.recommendation.best).not.toBeNull();
    expect(queries.some((q) => q.startsWith("Sony WH-CH720N buy"))).toBe(true);
    const sony = r.recommendation.products.find((p) => p.product.name.startsWith("Sony"))!;
    expect(sony.product.reviews.some((x) => x.kind === "independent_review" && x.url.includes("rtings.com"))).toBe(true);
  });
});
