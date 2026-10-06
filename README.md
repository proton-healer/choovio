# Choovio

**Choose well. Buy with confidence.**

Choovio is an everyday shopping assistant. Tell it what you need, your budget and your delivery country, and it researches real products. It explains the tradeoffs and gives a short, sourced recommendation. It runs as a mobile-friendly web chat and as an [EconomyOS](https://os.virtuals.io) agent selling a **Shopping Comparison** offering on Virtuals ACP.

Choovio only gives advice. It never buys products, moves money, or asks for retailer logins.

---

## Quick start (local)

Requires Node.js â‰¥ 20.19.

```bash
npm install
cp .env.example .env          # add a search key (TAVILY_API_KEY, no card) and OPENAI_API_KEY (optional)
npm test                      # 120 tests
npm start                     # http://127.0.0.1:8787
```

- **Live mode** compares pasted product links with no keys at all. Open-ended searches ("headphones under $100") need a search provider: `TAVILY_API_KEY`, `SERPER_API_KEY`, `BRAVE_SEARCH_API_KEY`, or OpenAI web search via `OPENAI_API_KEY`.
- **Demo mode** (toggle in the header) uses fictional products on reserved `.example` domains. It works offline, and every result is marked **DEMO DATA**.

Terminal use:

```bash
npm run cli -- --demo "comfortable headphones under \$100 for long work calls in the US"
npm run cli -- "compare https://shop.example/a https://shop.example/b for the US"
npm run cli -- --json "â€¦"     # the structured ACP deliverable
```

## What it does

1. **Understands the request.** It parses budget, currency, delivery country, intended use and hard requirements. It asks only questions that change the answer (country, budget, use, or space for fit checks), and never asks for a street address.
2. **Researches.** It reads pasted links (up to 5) or runs a live search, then fetches pages through an SSRF-safe client.
3. **Extracts facts with provenance.** Data comes from schema.org JSON-LD, product meta tags and spec tables: exact model and variant, price and currency, stock, seller, shipping to your country, delivery time, returns, warranty, ratings and spec values. Each fact carries its source URL, the type of source and the time it was checked. Size and colour variants are folded into one product with offers for each variant.
4. **Compares.** It merges the same model across sources, flags specs where sources disagree, and finds complaints that recur across low-rated reviews.
5. **Ranks by fit and value.** It weighs budget (including stated shipping), availability, delivery to your country, preferences, must-haves, fit dimensions, review evidence and data completeness. Affiliate status is not an input.
6. **Recommends.** The result has a best choice and why it fits, two alternatives with tradeoffs, a comparison table, known and unknown costs, reasons to avoid each option, and links. ACP consumers get the same facts as structured JSON.

### Trust rules (enforced in code and tests)

| Rule | Where |
|---|---|
| Prices, stock, discounts and links come only from structured page data, never from an LLM. Unknowns are labeled "not stated". | `src/extraction/`, `src/research/llm.ts` |
| Over-budget, unpriced, other-currency (never converted), out-of-stock, not-delivered or won't-fit items can't be the best choice. | `src/compare/score.ts` |
| A "was" price is reported as the seller's claim, not as a verified discount. | `score.ts` |
| Manufacturer specs, retailer listings, seller-hosted ratings, independent reviews, search snippets and marketing copy are labeled separately. | `SourceKind` in `src/types.ts` |
| Affiliate commission never affects ranking (tested). Affiliate links are always marked and disclosed. | `score.ts`, `recommend/build.ts` |
| If nothing can be verified, the status is `insufficient`, not a guess. | `recommend/build.ts` |

### Security

- **SSRF protection.** Only http/https on default ports, with no credentials and no IP-literal hosts. Private and reserved IPv4/IPv6 ranges are blocked (including IPv4-mapped and NAT64). The socket is pinned to the validated DNS answer, so DNS rebinding can't slip through. Each redirect hop is re-validated, and responses are capped by size and time and limited to text content types. See `src/security/url.ts`.
- **Untrusted content.** Scripts, comments and hidden elements are stripped before anything reads a page. Injection phrasing (including hidden text) is detected, reported as a warning and penalised. The optional LLM sees page text only inside a data envelope, and any spec or complaint it returns is kept only if its quote appears verbatim on the page. See `src/security/untrusted.ts`.
- **Secrets stay server-side.** API keys live in `.env`. The browser talks only to `/api/*`. ACP keys stay in the ACP CLI's OS keychain, and Choovio never handles a private key.
- **UI.** It renders all page-derived text with `textContent`, allows only `http(s)` links (opened with `rel="noopener noreferrer nofollow"`), and serves a strict CSP.

## Architecture

```
src/
  research/   intent.ts (parse + clarifying questions) Â· search.ts (Tavily / Serper / Brave / OpenAI) Â· fetcher.ts (live/demo) Â· llm.ts (optional OpenAI)
  extraction/ structured.ts (JSON-LD, meta, spec tables) Â· product.ts (records, provenance, variants, complaints)
  compare/    merge.ts (same-model merge, spec conflicts) Â· score.ts (fit & value ranking)
  recommend/  build.ts (best/alternatives/table/costs/avoid/links) Â· render.ts (Choovio's voice)
  security/   url.ts (SSRF-safe fetch) Â· untrusted.ts (page text handling, injection scan)
  acp/        offering.ts (schema, validation, deliverable) Â· provider.ts (job loop) Â· cli.ts (acp CLI wrapper)
  x402/       paid.ts (pay-per-request HTTP API: POST /api/compare)
  demo/       fixtures.ts (labeled fictional data)
  pipeline.ts Â· chat.ts Â· server.ts Â· config.ts
web/          index.html Â· app.js Â· styles.css (ivory / deep teal / coral)
economyos/    agent-profile.json Â· offering.json
scripts/      register-offering.ts Â· agent-profile.ts Â· compare-cli.ts
test/         intent Â· security Â· scenarios Â· acp Â· x402
```

## EconomyOS / ACP

### Status of this agent

| Item | Value |
|---|---|
| CLI | `@virtuals-protocol/acp-cli` 1.0.40 (latest on npm) |
| Agent | **Choovio**, id `01a10caa-c4aa-7754-92dd-74bca3879414` |
| Wallet | `0x84b1001cbd4d45c2db5fe95476890de23410d212` (Base) |
| Email | `choovio@agents.world` |
| Signer | **Not yet approved.** Needed to set budgets and submit deliverables. |
| Offering | Prepared (`economyos/offering.json`), **not yet registered** |

### Why ACP Serve isn't used

The docs at os.virtuals.io describe `acp serve init/start/deploy` and `acp offering create --from-file`. Neither exists in the published CLI (checked on 2026-10-05: 1.0.40 is `latest`, and it has no `serve` command and no `--from-file` flag). Choovio therefore uses the documented **agent-driven provider workflow** (Provider Workflow, approach 2), and the TypeScript loop in `src/acp/provider.ts` drives the CLI:

```
acp events listen â†’ acp events drain (every 5s)
  requirement message â†’ validate
     â”œâ”€ invalid â†’ message the client why; no budget set, so no funds escrowed (job expires)
     â””â”€ valid   â†’ acp provider set-budget --amount <offering price>
  job.funded â†’ research (bounded under the 5-minute SLA) â†’ acp provider submit --deliverable <JSON>
     â””â”€ insufficient/failed research â†’ deliverable says status "insufficient" + message recommending
        rejection, so the client's escrow is returned. Choovio never claims success it can't support.
  job.completed / job.rejected / job.expired â†’ recorded in .acp/jobs.json
```

If `acp serve` ships later, `toDeliverable()` and `validateRequirement()` can be reused unchanged inside `handler.ts`.

### Offering: Shopping Comparison

- **Input** (JSON schema, validated by ACP and again by Choovio): `request` and/or `product_urls` (â‰¤5), `budget`, `currency`, `delivery_country` (required, ISO-2, no addresses), `preferences`.
- **Output:** the structured comparison JSON (`status`, `checked_at`, `best`, `alternatives`, `comparison_table`, `products` with offers/specs/conflicts/reviews/complaints/unknowns, `costs`, `avoid_if`, `links`, `sources` with timestamps, `uncertainties`, `disclosures`, `summary_markdown`).
- **Price:** 0.5 USDC (`CHOOVIO_PRICE_USDC`, shared with the x402 API). **SLA:** 5 minutes (`CHOOVIO_SLA_MINUTES`). Fund-transfer: no.

### Register and run (exact commands)

```bash
# 1. CLI and sign-in (already done on this machine)
npm install -g @virtuals-protocol/acp-cli
acp configure                       # browser sign-in

# 2. Agent (already created)
acp agent use --agent-id 01a10caa-c4aa-7754-92dd-74bca3879414

# 3. Signer â€” browser approval; "restricted" = ACP transactions only
acp agent add-signer --policy restricted

# 4. Offering â€” free to register, but it makes Choovio publicly hireable
npm run offering:register              # dry run, writes economyos/offering.json
npm run offering:register -- --apply   # registers via `acp offering create`

# 5. Run the provider (keep it running while listed)
npm run provider
```

Registering the offering and running the provider costs nothing. Choovio earns USDC through escrow (95% to the provider and 5% protocol fee, per ACP). Nothing here spends from the agent wallet. Hosted deployment (`acp serve deploy`) and paid compute are not used.

## Pay-per-request API (x402)

`POST /api/compare` sells the same Shopping Comparison to any agent, priced per request with [x402](https://x402.org). This is the endpoint to list in the [Nevermined Catalog](https://nevermined.ai/docs/products/catalog/publish-ai-service). It's off until `CHOOVIO_X402_PAY_TO` is set (see `.env.example`).

The body is the ACP requirement JSON (`request`, `product_urls`, `budget`, `currency`, `delivery_country`, `preferences`). The response is the ACP deliverable plus `charged`.

| Request | Response | Charged |
|---|---|---|
| No `PAYMENT-SIGNATURE` header (including probes and `GET`) | `402` with `PAYMENT-REQUIRED`, input schema and an example | No |
| Paid, but invalid JSON, schema error, street address or too vague | `400` with the reasons or clarifying questions. The payment is never verified. | No |
| Paid, but the server is busy | `503` + `retry-after` | No |
| Paid, but research fails or is `insufficient` | `502` / `422`. The payment is cancelled, never settled. | No |
| Paid and researched | `200` + `PAYMENT-RESPONSE` (settlement receipt) | Yes |
| Paid and researched, but settlement fails | `402`, and the result is withheld | No |

The `exact` scheme moves funds only at settlement, which runs after research succeeds. A caller therefore pays only for a recommendation Choovio can back up. Defaults are Base Sepolia (testnet) and $0.50. For real payments, set `CHOOVIO_X402_NETWORK=base`. The PayAI facilitator is then used automatically, with no account needed.

### Go live (simplest path)

1. **Try it on testnet.** Set `CHOOVIO_X402_PAY_TO=<your wallet>` and run `npm start`. `curl -i http://127.0.0.1:8787/api/compare` should return `402`.
2. **Deploy.** Push the repo to GitHub and create a Railway (or Render) service from it. The `Dockerfile` is picked up automatically. Copy your `.env` values into the service's variables, plus `CHOOVIO_X402_NETWORK=base` and `CHOOVIO_PUBLIC_URL=<the https URL it gives you>`. Use an always-on plan: free tiers that sleep can fail Nevermined's health probe.
3. **List it.** In the Nevermined app (Live), register an organization agent with endpoint `<public URL>/api/compare`, then submit it to the Catalog under *Search & Research*.

## Credentials

| Credential | Needed for | Without it |
|---|---|---|
| `TAVILY_API_KEY`, `SERPER_API_KEY`, `BRAVE_SEARCH_API_KEY` (any one; `CHOOVIO_SEARCH_PROVIDER` picks) | Open-ended live search, independent-review lookup | Pasted links and demo mode still work |
| `OPENAI_API_KEY` (optional; also a search fallback) | Better request understanding; spec and complaint extraction from page text | Deterministic parsing and extraction only |
| `CHOOVIO_X402_PAY_TO` (+ a mainnet facilitator for real payments) | The x402 paid API and a Nevermined Catalog listing | `/api/compare` is off |
| ACP sign-in + approved signer (`acp configure`, `acp agent add-signer`) | Selling the offering on ACP | Web app works fully; the provider can't accept jobs |

## Tests

`npm test` runs 120 tests:

- **Budget constraints:** over-budget items are never best, stated shipping counts toward the budget, and a result is `insufficient` rather than stretching the budget.
- **Missing prices:** prices are never invented, unpriced items are never best, unreachable links are reported, and currencies are never silently converted.
- **Conflicting specs:** manufacturer and retailer pages for the same model are merged and disagreements are flagged with both sources. Different variants are not merged.
- **Unavailable products:** out-of-stock items, "currently unavailable" text, not-delivered-to-country, and variant pages where only some sizes are in stock.
- **Malicious pages:** visible and hidden injection text is flagged and penalised, can't change prices or warranty, and never reaches the deliverable. LLM output without a verbatim quote is dropped.
- **Security:** private and reserved IP ranges, IP-literal and obfuscated hosts, credentials, ports, the pinned DNS lookup, and stripping of hidden or scripted content.
- **ACP:** requirement validation (including extra keys and street addresses), decline without budget, set-budget at the offering price, a single submission per job, honest `insufficient` deliverables on failure, and deliverable size limits.
- **x402:** a real x402 resource server against a fake facilitator. Covered: 402 discovery (`POST` and `GET`), verify → research → settle, bad or vague requests rejected before the payment is touched, no settlement when research fails or is insufficient, results withheld when settlement fails, and wrong-amount payments rejected.
