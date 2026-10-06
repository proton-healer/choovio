/**
 * Choovio web server: static chat UI + JSON API. Secrets stay server-side.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { chatTurn, DraftSchema } from "./chat.js";
import { config, credentialStatus } from "./config.js";
import { DemoSearchProvider, DEMO_NOTICE, demoPages } from "./demo/fixtures.js";
import { FixtureFetcher, LiveFetcher } from "./research/fetcher.js";
import { createLlmHelper } from "./research/llm.js";
import { liveFx } from "./research/fx.js";
import { createSearchProvider } from "./research/search.js";
import { liveResearcher } from "./acp/provider.js";
import { createPaidCompareHandler, createX402Server, PAID_PATH } from "./x402/paid.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(here, "..", "web");

const ChatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  draft: DraftSchema.nullable().optional(),
  mode: z.enum(["live", "demo"]).default("live"),
});

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

// Simple per-IP rate limit: 12 research requests per minute.
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 12;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const extra = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  res.writeHead(status, { "cache-control": "no-store", ...extra, "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 32_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const llm = createLlmHelper();
const liveSearch = createSearchProvider();
const liveFetcher = new LiveFetcher();
const demoFetcher = new FixtureFetcher(demoPages());
const demoSearch = new DemoSearchProvider();

// Pay-per-request API for agents (x402). Enabled when a payout address is configured.
const paidCompare = config.x402.payTo
  ? createPaidCompareHandler({
      httpServer: createX402Server(config.x402),
      research: liveResearcher({ deadlineMs: config.x402.deadlineMs }),
      maxConcurrent: config.x402.maxConcurrent,
      send,
      readBody: (req) => readBody(req),
    })
  : null;

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const ip = req.socket.remoteAddress ?? "?";
  if (rateLimited(ip)) return send(res, 429, { error: "Too many requests — please wait a minute." });
  let body: z.infer<typeof ChatBody>;
  try {
    body = ChatBody.parse(JSON.parse(await readBody(req)));
  } catch {
    return send(res, 400, { error: "Invalid request" });
  }
  if (body.mode === "demo" && !config.demoAllowed) return send(res, 400, { error: "Demo mode is disabled" });
  const deps =
    body.mode === "demo"
      ? { fetcher: demoFetcher, search: demoSearch, llm: null }
      : { fetcher: liveFetcher, search: liveSearch, llm, fx: liveFx };
  try {
    const reply = await chatTurn(body.message, body.draft ?? null, deps);
    send(res, 200, { ...reply, notice: body.mode === "demo" ? DEMO_NOTICE : null });
  } catch (e) {
    console.error("chat error:", e);
    send(res, 500, { error: "Something went wrong while researching. Please try again." });
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return void handleChat(req, res);
  if (paidCompare && new URL(req.url ?? "/", "http://x").pathname === PAID_PATH) {
    return void paidCompare(req, res).catch((e) => {
      console.error("paid compare error:", e);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong. You were not charged." });
    });
  }
  if (req.method === "GET" && req.url === "/api/status") {
    return send(res, 200, { ...credentialStatus(), offering: { name: config.acp.offeringName, priceUsdc: config.acp.priceUsdc, slaMinutes: config.acp.slaMinutes } });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405, SECURITY_HEADERS);
  res.end();
});

server.listen(config.port, config.host, () => {
  const s = credentialStatus();
  console.log(`Choovio running at http://${config.host}:${config.port}`);
  console.log(`  live search: ${liveSearch ? `on (${liveSearch.name})` : "OFF — set TAVILY_API_KEY, SERPER_API_KEY, BRAVE_SEARCH_API_KEY or OPENAI_API_KEY (product links still work)"}`);
  console.log(`  LLM assist:  ${s.llm ? `on (${config.model})` : "off — optional, set OPENAI_API_KEY"}`);
  console.log(`  demo mode:   ${s.demoAllowed ? "available (clearly labeled)" : "disabled"}`);
  console.log(`  paid API:    ${paidCompare ? `POST ${PAID_PATH} at $${config.x402.priceUsd} on ${config.x402.network} (x402)` : "off — set CHOOVIO_X402_PAY_TO to enable"}`);
});
