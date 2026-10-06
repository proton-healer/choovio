/**
 * Run a comparison from the terminal.
 *
 *   npm run cli -- "comfortable headphones under $100 for long work calls in the US"
 *   npm run cli -- --demo "headphones under $100 for work calls in the US"
 *   npm run cli -- --json "https://example.com/p/1 https://example.com/p/2 in the US"
 */
import { toDeliverable } from "../src/acp/offering.js";
import { config } from "../src/config.js";
import { DemoSearchProvider, demoPages } from "../src/demo/fixtures.js";
import { runComparison } from "../src/pipeline.js";
import { FixtureFetcher, LiveFetcher } from "../src/research/fetcher.js";
import { liveFx } from "../src/research/fx.js";
import { createLlmHelper } from "../src/research/llm.js";
import { createSearchProvider } from "../src/research/search.js";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const json = args.includes("--json");
const text = args.filter((a) => !a.startsWith("--")).join(" ");
if (!text) {
  console.error('Usage: npm run cli -- [--demo] [--json] "what you want to buy, budget, country"');
  process.exit(2);
}

const deps = demo
  ? { fetcher: new FixtureFetcher(demoPages()), search: new DemoSearchProvider(), llm: null }
  : { fetcher: new LiveFetcher(), search: createSearchProvider(), llm: createLlmHelper(), fx: liveFx, log: (m: string) => console.error(m) };

const result = await runComparison({ text }, deps);
if (result.type === "questions") {
  console.log("Choovio needs a bit more info:");
  for (const q of result.questions) console.log(`- ${q.question}`);
  process.exit(0);
}
console.log(json ? JSON.stringify(toDeliverable(result.recommendation), null, 2) : result.recommendation.summary);
