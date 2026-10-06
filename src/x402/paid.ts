/**
 * Pay-per-request HTTP API: POST /api/compare, priced on the wire with x402.
 *
 *   no PAYMENT-SIGNATURE header      → 402 with the price and input schema (free probe / discovery)
 *   payment + bad or unclear request → 400, payment is never verified or settled
 *   payment + valid request          → verify → research → settle → 200 + PAYMENT-RESPONSE
 *     └─ research fails or is "insufficient" → payment is cancelled, never settled; the caller pays nothing
 *
 * The "exact" scheme only moves funds at settlement, so the caller is charged
 * only for a recommendation Choovio can back up.
 */
import type http from "node:http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext, type HTTPResponseInstructions, type RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { DELIVERABLE_DESCRIPTION, OFFERING_DESCRIPTION, REQUIREMENT_JSON_SCHEMA, toDeliverable, validateRequirement } from "../acp/offering.js";
import { requirementToInput, type Researcher } from "../acp/provider.js";
import { config } from "../config.js";
import { missingQuestions, parseRequest } from "../research/intent.js";

export const PAID_PATH = "/api/compare";

export interface X402Settings {
  payTo: string;
  priceUsd: number;
  network: `${string}:${string}`;
  facilitatorUrl: string;
  facilitatorToken?: string;
  deadlineMs: number;
  maxConcurrent: number;
  publicUrl?: string;
}

/** Build the x402 resource server for the paid route. Pass a facilitator to override the HTTP one (tests). */
export function createX402Server(s: X402Settings, facilitator?: FacilitatorClient): x402HTTPResourceServer {
  const token = s.facilitatorToken;
  const client =
    facilitator ??
    new HTTPFacilitatorClient({
      url: s.facilitatorUrl,
      ...(token
        ? {
            createAuthHeaders: async () => {
              const h = { Authorization: `Bearer ${token}` };
              return { verify: h, settle: h, supported: h };
            },
          }
        : {}),
    });
  const resourceServer = new x402ResourceServer(client).register(s.network, new ExactEvmScheme());
  const route: RouteConfig = {
    accepts: { scheme: "exact", network: s.network, payTo: s.payTo, price: `$${s.priceUsd}`, maxTimeoutSeconds: Math.ceil(s.deadlineMs / 1000) + 60 },
    ...(s.publicUrl ? { resource: `${s.publicUrl}${PAID_PATH}` } : {}),
    description: `Choovio Shopping Comparison. ${OFFERING_DESCRIPTION}`,
    mimeType: "application/json",
    serviceName: "Choovio",
    tags: ["shopping", "product-comparison", "research"],
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        service: "Choovio Shopping Comparison",
        how_to_call: `POST ${PAID_PATH} with a JSON body matching input_schema and an x402 PAYMENT-SIGNATURE header. You are charged only when a recommendation is returned.`,
        input_schema: REQUIREMENT_JSON_SCHEMA,
        output: DELIVERABLE_DESCRIPTION,
        example: { request: "noise-cancelling headphones for long work calls", budget: 150, currency: "USD", delivery_country: "US" },
      },
    }),
  };
  return new x402HTTPResourceServer(resourceServer, { [`POST ${PAID_PATH}`]: route, [`GET ${PAID_PATH}`]: route });
}

function adapterFor(req: http.IncomingMessage, body: unknown): HTTPAdapter {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const header = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    getHeader: header,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => (config.x402.publicUrl ? `${config.x402.publicUrl}${url.pathname}` : url.toString()),
    getAcceptHeader: () => header("accept") ?? "",
    getUserAgent: () => header("user-agent") ?? "",
    getBody: () => body,
  };
}

type Send = (res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;

export interface PaidCompareDeps {
  httpServer: x402HTTPResourceServer;
  research: Researcher;
  maxConcurrent: number;
  send: Send;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  log?: (msg: string) => void;
}

/** Returns the request handler for the paid route. Call `ready` once at startup. */
export function createPaidCompareHandler(deps: PaidCompareDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[choovio-x402] ${new Date().toISOString()} ${m}`));
  let active = 0;
  let initError: string | null = null;
  const ready = deps.httpServer.initialize().catch((e: unknown) => {
    initError = (e as Error).message;
    log(`facilitator setup failed, paid API disabled: ${initError}`);
  });

  const writeInstructions = (res: http.ServerResponse, r: HTTPResponseInstructions): void => {
    if (r.isHtml) {
      res.writeHead(r.status, { ...r.headers, "content-type": "text/html; charset=utf-8" });
      res.end(String(r.body ?? ""));
      return;
    }
    deps.send(res, r.status, r.body ?? {}, r.headers);
  };

  return async function handlePaidCompare(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await ready;
    if (initError) return deps.send(res, 503, { error: "Paid API is temporarily unavailable." });

    const paymentHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
    let raw = "";
    try {
      if (req.method === "POST") raw = await deps.readBody(req);
    } catch {
      return deps.send(res, 413, { error: "Request too large" });
    }

    // Validate before touching the payment, so a bad request never costs anything.
    let requirement: ReturnType<typeof validateRequirement> | null = null;
    if (paymentHeader) {
      if (req.method !== "POST") return deps.send(res, 405, { error: `Send a POST to ${PAID_PATH} with a JSON body.` });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return deps.send(res, 400, { error: "Body must be JSON.", input_schema: REQUIREMENT_JSON_SCHEMA, charged: false });
      }
      requirement = validateRequirement(parsed);
      if (!requirement.ok) return deps.send(res, 400, { error: "Invalid request.", details: requirement.errors, input_schema: REQUIREMENT_JSON_SCHEMA, charged: false });
      const questions = missingQuestions(parseRequest(requirementToInput(requirement.value)));
      if (questions.length) return deps.send(res, 400, { error: "More detail is needed before Choovio can research this.", questions, charged: false });
      if (active >= deps.maxConcurrent) return deps.send(res, 503, { error: "Busy, please retry shortly.", charged: false }, { "retry-after": "30" });
    }

    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const context: HTTPRequestContext = { adapter: adapterFor(req, body), path: new URL(req.url ?? "/", "http://x").pathname, method: req.method ?? "GET", paymentHeader };
    const result = await deps.httpServer.processHTTPRequest(context);
    if (result.type === "payment-error") return writeInstructions(res, result.response);
    if (result.type === "no-payment-required" || !requirement?.ok) return deps.send(res, 500, { error: "Payment configuration error." });

    active++;
    const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = result;
    const cancel = async (reason: "handler_threw" | "handler_failed", status: number, error?: unknown) => {
      try {
        await cancellationDispatcher.cancel({ reason, error, responseStatus: status });
      } catch (e) {
        log(`cancel failed: ${(e as Error).message}`);
      }
    };
    try {
      let rec;
      try {
        rec = await deps.research(requirement.value);
      } catch (e) {
        log(`research failed, payment not settled: ${(e as Error).message}`);
        await cancel("handler_threw", 502, e);
        return deps.send(res, 502, { error: "Research failed. You were not charged.", charged: false });
      }
      const deliverable = toDeliverable(rec);
      if (rec.status === "insufficient") {
        await cancel("handler_failed", 422);
        return deps.send(res, 422, { ...deliverable, charged: false, note: "Choovio could not verify enough facts for a recommendation, so the payment was not settled." });
      }
      const payload = Buffer.from(JSON.stringify({ ...deliverable, charged: true }));
      const settled = await deps.httpServer.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, { request: context, responseBody: payload });
      if (!settled.success) {
        log(`settlement failed: ${settled.errorReason}${settled.errorMessage ? ` (${settled.errorMessage})` : ""}`);
        return writeInstructions(res, settled.response);
      }
      log(`settled ${paymentRequirements.amount} on ${settled.network} tx ${settled.transaction} (${rec.status})`);
      deps.send(res, 200, JSON.parse(payload.toString("utf8")), settled.headers);
    } finally {
      active--;
    }
  };
}
