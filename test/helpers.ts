import { productPageHtml } from "../src/demo/fixtures.js";
import { runComparison } from "../src/pipeline.js";
import { FixtureFetcher } from "../src/research/fetcher.js";
import type { Recommendation } from "../src/types.js";

export const page = productPageHtml;

export async function compare(pages: Record<string, string>, text: string): Promise<Recommendation> {
  const urls = Object.keys(pages);
  const result = await runComparison({ text, urls }, { fetcher: new FixtureFetcher(pages), search: null, llm: null, now: () => new Date("2026-10-05T12:00:00Z") });
  if (result.type !== "recommendation") throw new Error(`Expected a recommendation, got questions: ${JSON.stringify(result.questions)}`);
  return result.recommendation;
}

export function nameOf(rec: Recommendation, id: string | undefined): string | undefined {
  return rec.products.find((p) => p.product.id === id)?.product.name;
}
