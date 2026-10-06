import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { Requirement } from "../src/acp/offering.js";
import { DemoSearchProvider, demoPages } from "../src/demo/fixtures.js";
import { runComparison } from "../src/pipeline.js";
import { buildRecommendation } from "../src/recommend/build.js";
import { FixtureFetcher } from "../src/research/fetcher.js";
import { parseRequest } from "../src/research/intent.js";
import type { Recommendation } from "../src/types.js";
import { httpNeverminedFacilitator, isNeverminedToken, type NeverminedFacilitator, type NeverminedSettings, type PaymentRequired } from "../src/x402/nevermined.js";
import { createPaidCompareHandler, createX402Server, PAID_PATH } from "../src/x402/paid.js";

const NETWORK = "eip155:84532" as const;
const PAY_TO = "0x84b1001cbd4d45c2db5fe95476890de23410d212";
const NVM: NeverminedSettings = { apiKey: "nvm:test", planId: "1812697397363282", agentId: "7721525629723628", environment: "live", creditsPerRequest: 1 };

class FakeUsdcFacilitator implements FacilitatorClient {
  verified = 0;
  settled = 0;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
  }
  async verify() {
    this.verified++;
    return { isValid: true, payer: "0x000000000000000000000000000000000000beef" };
  }
  async settle() {
    this.settled++;
    return { success: true, transaction: "0xfeed", network: NETWORK, payer: "0x000000000000000000000000000000000000beef" };
  }
}

class FakeNvmFacilitator implements NeverminedFacilitator {
  valid = true;
  settleOk = true;
  verifyCalls: Array<{ paymentRequired: PaymentRequired; maxAmount: string }> = [];
  settleCalls: Array<{ paymentRequired: PaymentRequired; maxAmount: string; agentRequestId?: string }> = [];
  async verify(body: { paymentRequired: PaymentRequired; x402AccessToken: string; maxAmount: string }) {
    this.verifyCalls.push(body);
    return this.valid ? { isValid: true, agentRequestId: "arId-1", agentRequest: { agentRequestId: "arId-1" } } : { isValid: false, invalidReason: "Insufficient balance" };
  }
  async settle(body: { paymentRequired: PaymentRequired; x402AccessToken: string; maxAmount: string; agentRequestId?: string }) {
    this.settleCalls.push(body);
    return this.settleOk ? { success: true, transaction: "0xc0ffee", creditsRedeemed: "1", remainingBalance: "4" } : { success: false, errorReason: "Insufficient credits" };
  }
}

async function demoResearch(req: Requirement): Promise<Recommendation> {
  const r = await runComparison(
    { text: req.request ?? "", budget: req.budget ?? null, currency: req.currency ?? null, country: req.delivery_country, preferences: req.preferences ?? [] },
    { fetcher: new FixtureFetcher(demoPages()), search: new DemoSearchProvider(), llm: null },
  );
  if (r.type !== "recommendation") throw new Error("expected recommendation");
  return r.recommendation;
}

const insufficient = async (req: Requirement): Promise<Recommendation> =>
  buildRecommendation({ request: parseRequest({ text: req.request ?? "", country: req.delivery_country, budget: req.budget ?? null }), ranked: [], dataMode: "live", checkedAt: new Date().toISOString(), failures: [], notes: [] });

const usdc = new FakeUsdcFacilitator();
const nvm = new FakeNvmFacilitator();
let research: (req: Requirement) => Promise<Recommendation> = demoResearch;
let researchCalls = 0;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const handler = createPaidCompareHandler({
    httpServer: createX402Server({ payTo: PAY_TO, priceUsd: 0.5, network: NETWORK, facilitatorUrl: "unused", deadlineMs: 60_000, maxConcurrent: 2 }, usdc),
    research: (req) => {
      researchCalls++;
      return research(req);
    },
    maxConcurrent: 2,
    send: (res, status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    },
    readBody: async (req) => {
      let s = "";
      for await (const c of req) s += c;
      return s;
    },
    log: () => {},
    nevermined: { settings: NVM, facilitator: nvm },
  });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  usdc.verified = usdc.settled = 0;
  nvm.valid = nvm.settleOk = true;
  nvm.verifyCalls = [];
  nvm.settleCalls = [];
  research = demoResearch;
  researchCalls = 0;
});

const good = { request: "comfortable headphones for long work calls", budget: 100, currency: "USD", delivery_country: "US" };
const decode = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);

/** A token shaped like the one getX402AccessToken returns for a crypto plan. */
const planToken = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: PAID_PATH },
    accepted: { scheme: "nvm:erc4337", network: "eip155:8453", planId: NVM.planId, extra: { version: "1", agentId: NVM.agentId, httpVerb: "POST" } },
    payload: { signature: "0x1234", authorization: { from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", sessionKeysProvider: "zerodev", sessionKeys: [] } },
    extensions: {},
  }),
).toString("base64");

const planPost = (body: unknown) =>
  fetch(base + PAID_PATH, { method: "POST", headers: { "content-type": "application/json", "payment-signature": planToken }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("Nevermined plan credits on the paid endpoint", () => {
  it("advertises both the USDC price and the plan in the 402", async () => {
    const r = await fetch(base + PAID_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) });
    expect(r.status).toBe(402);
    const { accepts } = decode(r.headers.get("payment-required"));
    expect(accepts.map((a: { scheme: string }) => a.scheme)).toEqual(["exact", "nvm:erc4337"]);
    expect(accepts[1]).toMatchObject({ network: "eip155:8453", planId: NVM.planId, extra: { agentId: NVM.agentId, httpVerb: "POST" } });
  });

  it("also advertises the plan on the GET probe", async () => {
    const r = await fetch(base + PAID_PATH, { headers: { accept: "application/json" } });
    expect(r.status).toBe(402);
    expect(decode(r.headers.get("payment-required")).accepts[1].scheme).toBe("nvm:erc4337");
  });

  it("verifies credits, researches, then burns one credit", async () => {
    const r = await planPost(good);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.charged).toBe(true);
    expect(body.best?.name).toBeTruthy();
    expect(decode(r.headers.get("payment-response"))).toMatchObject({ success: true, creditsRedeemed: "1" });
    expect(nvm.verifyCalls).toHaveLength(1);
    expect(nvm.verifyCalls[0]).toMatchObject({ maxAmount: "1", paymentRequired: { resource: { url: PAID_PATH }, accepts: [{ planId: NVM.planId }] } });
    expect(nvm.settleCalls).toHaveLength(1);
    expect(nvm.settleCalls[0]).toMatchObject({ maxAmount: "1", agentRequestId: "arId-1" });
    expect([usdc.verified, usdc.settled, researchCalls]).toEqual([0, 0, 1]);
  });

  it("rejects a token without credits before researching", async () => {
    nvm.valid = false;
    const r = await planPost(good);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toContain("Insufficient balance");
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect([researchCalls, nvm.settleCalls.length]).toEqual([0, 0]);
  });

  it("rejects a bad request before touching the plan", async () => {
    const r = await planPost({ ...good, wallet_private_key: "0xabc" });
    expect(r.status).toBe(400);
    expect([nvm.verifyCalls.length, nvm.settleCalls.length, researchCalls]).toEqual([0, 0, 0]);
  });

  it("does not burn credits when research is insufficient", async () => {
    research = insufficient;
    const r = await planPost(good);
    expect(r.status).toBe(422);
    expect((await r.json()).charged).toBe(false);
    expect(nvm.settleCalls).toHaveLength(0);
  });

  it("does not burn credits when research throws", async () => {
    research = async () => {
      throw new Error("search down");
    };
    const r = await planPost(good);
    expect(r.status).toBe(502);
    expect(nvm.settleCalls).toHaveLength(0);
  });

  it("withholds the result when credits cannot be burned", async () => {
    nvm.settleOk = false;
    const r = await planPost(good);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.best).toBeUndefined();
    expect(body.charged).toBe(false);
  });
});

describe("Nevermined token detection", () => {
  it("tells plan tokens from direct USDC payments", () => {
    expect(isNeverminedToken(planToken)).toBe(true);
    expect(isNeverminedToken(Buffer.from(JSON.stringify({ accepted: { scheme: "exact" } })).toString("base64"))).toBe(false);
    expect(isNeverminedToken("not base64 json")).toBe(false);
  });
});

describe("Nevermined REST facilitator", () => {
  const pr: PaymentRequired = { x402Version: 2, resource: { url: PAID_PATH }, accepts: [], extensions: {} };
  const fakeFetch = (status: number, json: unknown, seen: Array<{ url: string; init: RequestInit }>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("calls the live verify endpoint with the API key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = httpNeverminedFacilitator("nvm:key", "live", fakeFetch(201, { isValid: true, agentRequestId: "a" }, seen));
    expect((await f.verify({ paymentRequired: pr, x402AccessToken: "t", maxAmount: "1" })).isValid).toBe(true);
    expect(seen[0]!.url).toBe("https://api.live.nevermined.app/api/v1/x402/verify");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer nvm:key");
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ x402AccessToken: "t", maxAmount: "1" });
  });

  it("treats a non-2xx verify as invalid", async () => {
    const f = httpNeverminedFacilitator("k", "sandbox", fakeFetch(400, { message: "bad token" }, []));
    expect(await f.verify({ paymentRequired: pr, x402AccessToken: "t", maxAmount: "1" })).toEqual({ isValid: false, invalidReason: "bad token" });
  });

  it("treats a 200 settle without success:true as a failure", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = httpNeverminedFacilitator("k", "sandbox", fakeFetch(200, { success: false, errorReason: "Cannot order plan" }, seen));
    expect(await f.settle({ paymentRequired: pr, x402AccessToken: "t", maxAmount: "1" })).toEqual({ success: false, errorReason: "Cannot order plan" });
    expect(seen[0]!.url).toBe("https://api.sandbox.nevermined.app/api/v1/x402/settle");
  });
});
