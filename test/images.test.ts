import { describe, expect, it } from "vitest";
import { buildFromPage, resolveImageUrl } from "../src/extraction/product.js";

const build = (url: string, html: string) =>
  buildFromPage({ url, html, checkedAt: "2026-10-06T00:00:00Z", dataMode: "live", country: "US" }).products[0]!;

const ld = (product: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme Kettle", offers: { "@type": "Offer", price: 40, priceCurrency: "USD" }, ...product })}</script></head><body></body></html>`;

describe("product images", () => {
  it("reads a plain JSON-LD image URL", () => {
    expect(build("https://shop.example/k", ld({ image: "https://cdn.example/k.jpg" })).imageUrl).toBe("https://cdn.example/k.jpg");
  });

  it("reads the url of a JSON-LD ImageObject (not its name)", () => {
    const p = build("https://shop.example/k", ld({ image: [{ "@type": "ImageObject", name: "Kettle photo", url: "https://cdn.example/k.png" }] }));
    expect(p.imageUrl).toBe("https://cdn.example/k.png");
  });

  it("resolves relative and protocol-relative images against the page", () => {
    expect(build("https://shop.example/p/k", ld({ image: "/img/k.jpg" })).imageUrl).toBe("https://shop.example/img/k.jpg");
    expect(build("https://shop.example/p/k", ld({ image: "//cdn.example/k.jpg" })).imageUrl).toBe("https://cdn.example/k.jpg");
  });

  it("falls back to og:image when structured data has no image", () => {
    const html = `<html><head><title>Acme Kettle | Shop</title><meta property="og:image" content="https://cdn.example/og.jpg?w=800&amp;h=800"><meta property="product:price:amount" content="40"><meta property="product:price:currency" content="USD"></head></html>`;
    expect(build("https://shop.example/k", html).imageUrl).toBe("https://cdn.example/og.jpg?w=800&h=800");
  });

  it("rejects non-web schemes and upgrades http", () => {
    expect(resolveImageUrl("javascript:alert(1)", "https://shop.example/")).toBeNull();
    expect(resolveImageUrl("data:image/png;base64,AAAA", "https://shop.example/")).toBeNull();
    expect(resolveImageUrl("http://cdn.example/a.jpg", "https://shop.example/")).toBe("https://cdn.example/a.jpg");
  });
});
