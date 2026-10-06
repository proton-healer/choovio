import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AcpCli } from "../src/acp/cli.js";
import { offeringConfig, toDeliverable, validateRequirement } from "../src/acp/offering.js";
import { ChoovioProvider, compactDeliverable, MAX_DELIVERABLE_CHARS, type AcpEvent } from "../src/acp/provider.js";
import { DemoSearchProvider, demoPages } from "../src/demo/fixtures.js";
import { runComparison } from "../src/pipeline.js";
import { buildRecommendation } from "../src/recommend/build.js";
import { FixtureFetcher } from "../src/research/fetcher.js";
import { parseRequest } from "../src/research/intent.js";
import type { Recommendation } from "../src/types.js";

class FakeCli implements AcpCli {
  calls: string[][] = [];
  async run(args: string[]) {
    this.calls.push(args);
    return { success: true };
  }
  spawnListener(): ChildProcess {
    throw new Error("not used");
  }
  find(cmd: string) {
    return this.calls.filter((c) => c.slice(0, 2).join(" ") === cmd);
  }
}

async function demoRecommendation(): Promise<Recommendation> {
  const r = await runComparison({ text: "headphones under $100 for long work calls in the US" }, { fetcher: new FixtureFetcher(demoPages()), search: new DemoSearchProvider(), llm: null });
  if (r.type !== "recommendation") throw new Error("expected recommendation");
  return r.recommendation;
}

const requirement = (content: unknown): AcpEvent => ({
  jobId: "42",
  chainId: 8453,
  status: "open",
  roles: ["provider"],
  availableTools: ["setBudget", "sendMessage", "wait"],
  entry: { kind: "message", contentType: "requirement", content: JSON.stringify(content) },
});
const funded: AcpEvent = { jobId: "42", chainId: 8453, status: "funded", roles: ["provider"], availableTools: ["submit"], entry: { kind: "system", event: { type: "job.funded" } } };

describe("requirement validation", () => {
  it("accepts a well-formed request", () => {
    const v = validateRequirement({ request: "headphones for calls", budget: 100, currency: "USD", delivery_country: "US" });
    expect(v.ok).toBe(true);
  });

  it.each([
    [{ request: "headphones", budget: 100 }, /delivery_country/],
    [{ delivery_country: "US" }, /either 'request' or/],
    [{ product_urls: ["http://127.0.0.1/admin"], delivery_country: "US" }, /rejected/],
    [{ product_urls: Array(6).fill("https://a.example/x"), delivery_country: "US" }, /product_urls/],
    [{ request: "headphones", budget: 100, delivery_country: "US", wallet_private_key: "0xabc" }, /Unrecognized key/i],
    [{ request: "send to 221 Baker Street please, headphones", budget: 50, delivery_country: "GB" }, /street address/],
    [{ request: "headphones", delivery_country: "US" }, /budget/],
    [{ request: "headphones", budget: -5, delivery_country: "US" }, /budget/],
  ])("rejects %j", (input, pattern) => {
    const v = validateRequirement(input);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(pattern);
  });

  it("offering config matches the brief", () => {
    const o = offeringConfig();
    expect(o.name).toBe("Shopping Comparison");
    expect(o.priceValue).toBe(0.5);
    expect(o.slaMinutes).toBe(5);
    expect(o.requiredFunds).toBe(false);
  });
});

describe("provider job flow", () => {
  it("declines invalid requirements without setting a budget", async () => {
    const cli = new FakeCli();
    const provider = new ChoovioProvider(cli, async () => demoRecommendation(), { priceUsdc: 1, log: () => {} });
    await provider.handle(requirement({ request: "anything" }));
    expect(cli.find("provider set-budget")).toHaveLength(0);
    const msg = cli.find("message send")[0]!;
    expect(msg.join(" ")).toMatch(/no budget was set/);
    expect(provider.job("42")?.phase).toBe("declined");
  });

  it("valid job: set budget at offering price → research on funding → submit structured JSON", async () => {
    const cli = new FakeCli();
    const provider = new ChoovioProvider(cli, async () => demoRecommendation(), { priceUsdc: 1, log: () => {} });
    await provider.handle(requirement({ request: "headphones for long work calls", budget: 100, delivery_country: "US" }));
    const budget = cli.find("provider set-budget")[0]!;
    expect(budget).toEqual(["provider", "set-budget", "--job-id", "42", "--amount", "1", "--chain-id", "8453"]);
    await provider.handle(funded);
    const submit = cli.find("provider submit")[0]!;
    const deliverable = JSON.parse(submit[submit.indexOf("--deliverable") + 1]!);
    expect(deliverable.agent).toBe("Choovio");
    expect(deliverable.status).toBe("complete");
    expect(deliverable.best.name).toBeTruthy();
    expect(deliverable.sources.length).toBeGreaterThan(0);
    expect(provider.job("42")?.phase).toBe("submitted");
    // A duplicate funded event must not cause a second submission.
    await provider.handle(funded);
    expect(cli.find("provider submit")).toHaveLength(1);
  });

  it("insufficient research is submitted honestly and the client is told to reject for a refund", async () => {
    const cli = new FakeCli();
    const empty = buildRecommendation({ request: parseRequest({ text: "x", country: "US" }), ranked: [], dataMode: "live", checkedAt: new Date().toISOString(), failures: [], notes: ["Search failed"] });
    const provider = new ChoovioProvider(cli, async () => empty, { priceUsdc: 1, log: () => {} });
    await provider.handle(requirement({ request: "rare part", budget: 10, delivery_country: "US" }));
    await provider.handle(funded);
    const submit = cli.find("provider submit")[0]!;
    expect(JSON.parse(submit[submit.indexOf("--deliverable") + 1]!).status).toBe("insufficient");
    expect(cli.find("message send")[0]!.join(" ")).toMatch(/recommend rejecting/);
  });

  it("a crash during research still produces an honest deliverable", async () => {
    const cli = new FakeCli();
    const provider = new ChoovioProvider(cli, async () => { throw new Error("network down"); }, { priceUsdc: 1, log: () => {} });
    await provider.handle(requirement({ request: "toaster", budget: 40, delivery_country: "US" }));
    await provider.handle(funded);
    const d = JSON.parse(cli.find("provider submit")[0]!.at(-3)!);
    expect(d.status).toBe("insufficient");
    expect(d.error).toMatch(/network down/);
  });

  it("ignores events where Choovio is not the provider", async () => {
    const cli = new FakeCli();
    const provider = new ChoovioProvider(cli, async () => demoRecommendation(), { priceUsdc: 1, log: () => {} });
    await provider.handle({ ...requirement({ request: "x", budget: 1, delivery_country: "US" }), roles: ["client"] });
    expect(cli.calls).toHaveLength(0);
  });
});

describe("deliverable size", () => {
  it("compacts to stay within the command-line limit while keeping key facts", async () => {
    const rec = await demoRecommendation();
    const big = toDeliverable(rec);
    big.uncertainties = Array.from({ length: 400 }, (_, i) => `uncertainty number ${i} with some padding text to make it longer`);
    const s = compactDeliverable(big);
    expect(s.length).toBeLessThanOrEqual(MAX_DELIVERABLE_CHARS);
    const parsed = JSON.parse(s);
    expect(parsed.best).toEqual(big.best);
    expect(parsed.status).toBe(big.status);
  });
});
