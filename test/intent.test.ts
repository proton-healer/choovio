import { describe, expect, it } from "vitest";
import { missingQuestions, parseBudget, parseCountry, parseDimensions, parseRequest } from "../src/research/intent.js";

describe("budget parsing", () => {
  it.each([
    ["headphones under $100", 100, "USD"],
    ["gift below £50 please", 50, "GBP"],
    ["a vacuum, budget of 300 euros", 300, "EUR"],
    ["no more than 1,299 dollars", 1299, "USD"],
    ["around $60", 66, "USD"],
  ])("%s", (text, max, currency) => {
    const b = parseBudget(text);
    expect(b.budget?.max).toBe(max);
    expect(b.currency).toBe(currency);
  });

  it("parses ranges", () => {
    expect(parseBudget("between $50 and $80").budget).toEqual({ min: 50, max: 80 });
  });

  it("returns null when no budget is stated", () => {
    expect(parseBudget("best robot vacuum for pet hair").budget).toBeNull();
  });
});

describe("country parsing", () => {
  it("finds countries without confusing the pronoun 'us'", () => {
    expect(parseCountry("help us find a kettle")).toBeNull();
    expect(parseCountry("delivered to the UK")).toBe("GB");
    expect(parseCountry("I live in Germany")).toBe("DE");
    expect(parseCountry("shipping to the US")).toBe("US");
    expect(parseCountry("is this a good deal? UK")).toBe("GB");
    expect(parseCountry("IS IT A GOOD DEAL IN MY KITCHEN")).toBeNull();
  });

  it("uses the delivery country's dollar for a bare $", () => {
    const r = parseRequest({ text: "blender under $150 in Canada" });
    expect(r.country).toBe("CA");
    expect(r.currency).toBe("CAD");
  });
});

describe("request kinds and clarifying questions", () => {
  it("detects a gift request and asks only what matters", () => {
    const r = parseRequest({ text: "Find a birthday gift for my dad under $50" });
    expect(r.kind).toBe("gift");
    const qs = missingQuestions(r);
    expect(qs.map((q) => q.field)).toEqual(["country", "use"]);
  });

  it("never asks for a street address", () => {
    const r = parseRequest({ text: "headphones" });
    for (const q of missingQuestions(r)) expect(q.question.toLowerCase()).not.toMatch(/street|postcode|zip|full address/);
  });

  it("asks nothing more when the request is complete", () => {
    const r = parseRequest({ text: "Find comfortable headphones under $100 for long work calls in the US" });
    expect(r.preferences).toContain("comfortable");
    expect(r.preferences).toContain("long work calls");
    expect(missingQuestions(r)).toEqual([]);
  });

  it("compares links without demanding a budget", () => {
    const r = parseRequest({ text: "Compare these https://a.example/1 https://b.example/2", country: "US" });
    expect(r.kind).toBe("compare_links");
    expect(r.urls).toHaveLength(2);
    expect(missingQuestions(r)).toEqual([]);
  });

  it("infers country from a retailer TLD", () => {
    expect(parseRequest({ text: "is this a good deal? https://shop.co.uk/p/1" }).country).toBe("GB");
  });

  it("fit checks parse dimensions and ask for space when missing", () => {
    expect(parseDimensions("will it fit a 60 x 60 x 85 cm space")).toEqual({ widthCm: 60, depthCm: 60, heightCm: 85 });
    const r = parseRequest({ text: "Will this washing machine fit my space? https://x.example/w in the US" });
    expect(r.kind).toBe("fit_check");
    expect(missingQuestions(r).map((q) => q.field)).toContain("space");
  });
});
