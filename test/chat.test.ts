import { describe, expect, it } from "vitest";
import { applyAnswer, chatTurn } from "../src/chat.js";
import { DemoSearchProvider, demoPages } from "../src/demo/fixtures.js";
import { FixtureFetcher } from "../src/research/fetcher.js";

const deps = { fetcher: new FixtureFetcher(demoPages()), search: new DemoSearchProvider(), llm: null };

describe("chat follow-ups", () => {
  it("asks only what's missing, then folds short answers back in", async () => {
    const first = await chatTurn("Find a birthday gift for my dad under $50", null, deps);
    expect(first.type).toBe("questions");
    if (first.type !== "questions") return;
    expect(first.questions.map((q) => q.field)).toEqual(["country", "use"]);

    const second = await chatTurn("UK, he loves listening to music while gardening", first.draft, deps);
    expect(second.type).toBe("recommendation");
    if (second.type !== "recommendation") return;
    expect(second.recommendation.request.country).toBe("GB");
    expect(second.recommendation.request.preferences).toContain("he loves listening to music while gardening");
    expect(second.recommendation.dataMode).toBe("demo");
  });

  it("understands a bare budget or country answer", () => {
    const d = { text: "headphones", country: null, budget: null, currency: null, preferences: [], pending: ["country", "budget"] as ("country" | "budget")[] };
    expect(applyAnswer(d, "Germany").country).toBe("DE");
    expect(applyAnswer(d, "80").budget).toBe(80);
    expect(applyAnswer(d, "£120").currency).toBe("GBP");
  });
});
