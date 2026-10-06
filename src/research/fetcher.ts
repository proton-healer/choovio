/**
 * Page fetchers. The live fetcher goes through the SSRF-safe client; the demo
 * fetcher serves clearly labeled fixture pages and never touches the network.
 */
import { config } from "../config.js";
import { safeFetch } from "../security/url.js";

export interface FetchedPage {
  finalUrl: string;
  html: string;
}

export interface PageFetcher {
  readonly mode: "live" | "demo";
  fetch(url: string): Promise<FetchedPage>;
}

export class LiveFetcher implements PageFetcher {
  readonly mode = "live" as const;
  async fetch(url: string): Promise<FetchedPage> {
    const res = await safeFetch(url, { timeoutMs: config.fetchTimeoutMs });
    if (res.status === 404 || res.status === 410) throw new Error(`Page not found (HTTP ${res.status})`);
    if (res.status === 403 || res.status === 429) throw new Error(`The site blocked automated access (HTTP ${res.status})`);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return { finalUrl: res.finalUrl, html: res.body };
  }
}

export class FixtureFetcher implements PageFetcher {
  readonly mode = "demo" as const;
  constructor(private readonly pages: Record<string, string>) {}
  async fetch(url: string): Promise<FetchedPage> {
    const html = this.pages[url];
    if (html === undefined) throw new Error("Page not found (HTTP 404)");
    return { finalUrl: url, html };
  }
}
