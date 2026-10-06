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
import { createPaidCompareHandler, createX402Server, PAID_PATH } from "../src/x402/paid.js";

const NETWORK = "eip155:84532" as const;
const PAY_TO = "0x84b1001cbd4d45c2db5fe95476890de23410d212";

class FakeFacilitator implements FacilitatorClient {
  verified = 0;
  settled = 0;
  settleOk = true;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
  }
  async verify() {
    this.verified++;
    return { isValid: true, payer: "0x000000000000000000000000000000000000beef" };
  }
  async settle() {
    this.settled++;
    return this.settleOk
      ? { success: true, transaction: "0xfeed", network: NETWORK, payer: "0x000000000000000000000000000000000000beef" }
      : { success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK };
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

const facilitator = new FakeFacilitator();
let research: (req: Requirement) => Promise<Recommendation> = demoResearch;
let researchCalls = 0;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const handler = createPaidCompareHandler({
    httpServer: createX402Server({ payTo: PAY_TO, priceUsd: 0.5, network: NETWORK, facilitatorUrl: "unused", deadlineMs: 60_000, maxConcurrent: 2 }, facilitator),
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
  });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  facilitator.verified = facilitator.settled = 0;
  facilitator.settleOk = true;
  research = demoResearch;
  researchCalls = 0;
});

const good = { request: "comfortable headphones for long work calls", budget: 100, currency: "USD", delivery_country: "US" };

async function paymentRequired() {
  const r = await fetch(base + PAID_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) });
  const header = r.headers.get("payment-required");
  return { status: r.status, body: await r.json(), header, decoded: header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null };
}

/** A structurally valid payment; the fake facilitator accepts any signature. */
async function paymentHeader() {
  const { decoded } = await paymentRequired();
  const accepted = decoded.accepts[0];
  const payload = {
    x402Version: 2,
    resource: decoded.resource,
    accepted,
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: { from: "0x000000000000000000000000000000000000beef", to: PAY_TO, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "22".repeat(32) },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

const paidPost = async (body: unknown) =>
  fetch(base + PAID_PATH, { method: "POST", headers: { "content-type": "application/json", "payment-signature": await paymentHeader() }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("x402 paid compare endpoint", () => {
  it("answers an unpaid request with 402, the price and the input schema", async () => {
    const { status, body, decoded } = await paymentRequired();
    expect(status).toBe(402);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount: "500000" });
    expect(body.input_schema.required).toContain("delivery_country");
    expect(researchCalls).toBe(0);
  });

  it("also answers an empty GET probe with 402", async () => {
    const r = await fetch(base + PAID_PATH, { headers: { accept: "application/json" } });
    expect(r.status).toBe(402);
    expect(r.headers.get("payment-required")).toBeTruthy();
  });

  it("verifies, researches, then settles a paid request", async () => {
    const r = await paidPost(good);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).not.toBe("insufficient");
    expect(body.charged).toBe(true);
    expect(body.best?.name).toBeTruthy();
    expect(r.headers.get("payment-response")).toBeTruthy();
    expect([facilitator.verified, facilitator.settled, researchCalls]).toEqual([1, 1, 1]);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["schema violation", { ...good, wallet_private_key: "0xabc" }],
    ["missing country", { request: "headphones", budget: 100 }],
    ["street address", { ...good, request: "headphones to 221 Baker Street" }],
  ])("rejects %s with 400 before touching the payment", async (_name, body) => {
    const r = await paidPost(body);
    expect(r.status).toBe(400);
    expect((await r.json()).charged).toBe(false);
    expect([facilitator.verified, facilitator.settled, researchCalls]).toEqual([0, 0, 0]);
  });

  it("asks clarifying questions for free instead of researching a vague request", async () => {
    const r = await paidPost({ request: "headphones", budget: 100, delivery_country: "US" });
    expect(r.status).toBe(400);
    expect((await r.json()).questions.length).toBeGreaterThan(0);
    expect(facilitator.settled).toBe(0);
  });

  it("does not settle when research is insufficient", async () => {
    research = insufficient;
    const r = await paidPost(good);
    expect(r.status).toBe(422);
    expect((await r.json()).charged).toBe(false);
    expect(facilitator.settled).toBe(0);
  });

  it("does not settle when research throws", async () => {
    research = async () => {
      throw new Error("search down");
    };
    const r = await paidPost(good);
    expect(r.status).toBe(502);
    expect(facilitator.settled).toBe(0);
  });

  it("withholds the result when settlement fails", async () => {
    facilitator.settleOk = false;
    const r = await paidPost(good);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.best).toBeUndefined();
  });

  it("rejects a payment for the wrong amount", async () => {
    const header = JSON.parse(Buffer.from(await paymentHeader(), "base64").toString("utf8"));
    header.accepted.amount = "1";
    const r = await fetch(base + PAID_PATH, { method: "POST", headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(header)).toString("base64") }, body: JSON.stringify(good) });
    expect(r.status).toBe(402);
    expect(researchCalls).toBe(0);
    expect(facilitator.settled).toBe(0);
  });
});
