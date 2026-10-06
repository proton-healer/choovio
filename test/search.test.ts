import { describe, expect, it } from "vitest";
import { FallbackSearchProvider, SearchHttpError, type SearchProvider, type SearchResult } from "../src/research/search.js";

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const hit: SearchResult[] = [{ url: "https://shop.example/p/1", title: "Headset", snippet: "" }];

/** Provider that throws the queued errors in order, then returns `hit`. */
function scripted(name: string, errors: unknown[]): SearchProvider & { calls: number } {
  return {
    name,
    calls: 0,
    async search() {
      const err = errors[this.calls++];
      if (err) throw err;
      return hit;
    },
  };
}

const opts = { country: "US", count: 20 };

describe("FallbackSearchProvider", () => {
  it("retries a timeout once on the same provider", async () => {
    const a = scripted("tavily", [timeout()]);
    const b = scripted("serper", []);
    await expect(new FallbackSearchProvider([a, b], 0).search("q", opts)).resolves.toEqual(hit);
    expect([a.calls, b.calls]).toEqual([2, 0]);
  });

  it("falls back to the next provider after repeated timeouts", async () => {
    const a = scripted("tavily", [timeout(), timeout()]);
    const b = scripted("serper", []);
    await expect(new FallbackSearchProvider([a, b], 0).search("q", opts)).resolves.toEqual(hit);
    expect([a.calls, b.calls]).toEqual([2, 1]);
  });

  it("does not retry a non-transient error but still falls back", async () => {
    const a = scripted("tavily", [new SearchHttpError(401)]);
    const b = scripted("serper", []);
    await expect(new FallbackSearchProvider([a, b], 0).search("q", opts)).resolves.toEqual(hit);
    expect([a.calls, b.calls]).toEqual([1, 1]);
  });

  it("moves on when a provider returns no results", async () => {
    const empty: SearchProvider = { name: "tavily", search: async () => [] };
    const b = scripted("serper", []);
    await expect(new FallbackSearchProvider([empty, b], 0).search("q", opts)).resolves.toEqual(hit);
    await expect(new FallbackSearchProvider([empty], 0).search("q", opts)).resolves.toEqual([]);
  });

  it("reports every provider's failure when all fail", async () => {
    const a = scripted("tavily", [timeout(), timeout()]);
    const b = scripted("serper", [new SearchHttpError(503), new SearchHttpError(503)]);
    await expect(new FallbackSearchProvider([a, b], 0).search("q", opts)).rejects.toThrow(
      "tavily: The operation was aborted due to timeout; serper: Search API returned HTTP 503",
    );
  });
});
