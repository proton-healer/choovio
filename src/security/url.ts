/**
 * External URL validation and SSRF-safe fetching.
 *
 * Rules:
 *  - only http/https, default ports, no embedded credentials
 *  - hostnames must be public DNS names; IP literals are refused outright
 *  - every resolved address is checked against private/reserved ranges, and the
 *    socket is pinned to the validated address (no DNS-rebinding window)
 *  - redirects are followed manually and each hop is re-validated
 *  - responses are capped in size and time, and only text types are accepted
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa"];

/** Parse and statically validate a URL. Does not touch the network. */
export function parseExternalUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError(`Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Non-standard ports are not allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("Missing host");
  if (net.isIP(host)) throw new UnsafeUrlError("IP address URLs are not allowed");
  if (!host.includes(".")) throw new UnsafeUrlError("Single-label hostnames are not allowed");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Private hostnames are not allowed");
  }
  url.hash = "";
  return url;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address to 8 groups of 16-bit integers. */
function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const n = ipv4ToInt(v4Match[1]!);
    addr = addr.slice(0, -v4Match[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable → treat as unsafe
  const [a, b] = g as [number, number, ...number[]];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) → check embedded v4
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return isPrivateV4(v4);
  }
  if (a === 0x64 && b === 0xff9b) return true; // NAT64 64:ff9b::/96
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return true; // 6to4 can embed private v4
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

/** DNS lookup that refuses to return private addresses. Used to pin sockets. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const unsafe = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || unsafe) {
      return (callback as (e: Error | null, a: string, f: number) => void)(
        new UnsafeUrlError(`Host ${hostname} resolves to a private or reserved address`),
        "",
        0,
      );
    }
    if ((options as dns.LookupOptions | undefined)?.all) {
      return (callback as unknown as (e: Error | null, a: dns.LookupAddress[]) => void)(null, list);
    }
    const first = list[0]!;
    (callback as (e: Error | null, a: string, f: number) => void)(null, first.address, first.family);
  });
};

/** Resolve and validate a hostname without fetching (used for early input validation). */
export async function assertPublicHost(url: URL): Promise<void> {
  const addresses = await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new UnsafeUrlError("Host does not resolve");
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new UnsafeUrlError(`Host ${url.hostname} resolves to a private or reserved address`);
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

const ALLOWED_TYPES = ["text/html", "application/xhtml+xml", "application/json", "application/ld+json", "text/plain"];

const USER_AGENT = "ChoovioBot/0.1 (+shopping research assistant; respects robots meta)";

function requestOnce(url: URL, opts: Required<SafeFetchOptions>, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        headers: { "user-agent": USER_AGENT, accept: opts.accept, "accept-language": "en;q=0.9" },
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: "" });
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (!ALLOWED_TYPES.some((t) => type.startsWith(t))) {
          res.destroy();
          return reject(new UnsafeUrlError(`Unsupported content type: ${type || "none"}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            // Keep what we have; product data is usually near the top.
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opts: Required<SafeFetchOptions> = {
    timeoutMs: options.timeoutMs ?? 12_000,
    maxBytes: options.maxBytes ?? 2_000_000,
    maxRedirects: options.maxRedirects ?? 4,
    accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
  };
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = parseExternalUrl(raw);
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await requestOnce(url, opts, signal);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new Error(`Redirect without location from ${url.href}`);
      url = parseExternalUrl(new URL(location, url).href);
      continue;
    }
    return {
      finalUrl: url.href,
      status: res.status,
      contentType: String(res.headers["content-type"] ?? ""),
      body: res.body,
    };
  }
  throw new Error("Too many redirects");
}
