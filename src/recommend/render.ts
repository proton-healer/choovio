/**
 * Renders a recommendation in Choovio's voice: friendly, practical, concise,
 * independent. No sales pressure, no jargon.
 */
import type { Recommendation } from "../types.js";

function nameOf(rec: Recommendation, id: string): string {
  return rec.products.find((p) => p.product.id === id)?.product.name ?? id;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderSummary(rec: Recommendation): string {
  const lines: string[] = [];
  const when = new Date(rec.checkedAt).toUTCString();
  if (rec.dataMode === "demo") lines.push("> **Demo data** — fictional sample products for testing. Not live prices.\n");

  if (!rec.best) {
    lines.push("I couldn't find an option I'd confidently recommend yet.");
    const reasons = [...new Set(rec.products.map((p) => p.ineligibleReason).filter(Boolean))];
    if (reasons.length) lines.push(`What got in the way: ${reasons.join("; ").toLowerCase()}.`);
    if (rec.uncertainties.length) lines.push("", "**What I couldn't verify**", ...rec.uncertainties.slice(0, 8).map((u) => `- ${u}`));
    lines.push("", "Want me to try a different budget, a nearby country, or a few specific product links?");
    lines.push("", `_Checked ${when}._`);
    return lines.join("\n");
  }

  const best = rec.products.find((p) => p.product.id === rec.best!.productId)!;
  lines.push(`**My pick: ${best.product.name}**${best.bestOffer?.price ? ` — ${rec.table.find((t) => t.productId === best.product.id)?.price}` : ""}`);
  if (rec.best.why.length) lines.push(...rec.best.why.map((w) => `- ${w}`));

  if (rec.alternatives.length) {
    lines.push("", "**Also worth a look**");
    for (const a of rec.alternatives) lines.push(`- **${nameOf(rec, a.productId)}** — ${a.tradeoff}`);
  }

  lines.push("", "| Product | Price | Stock | Delivery | Warranty & returns | Rating |", "|---|---|---|---|---|---|");
  for (const r of rec.table) lines.push(`| ${mdEscape(r.name)} | ${r.price} | ${r.availability} | ${mdEscape(r.delivery)} | ${mdEscape(r.warrantyReturns)} | ${mdEscape(r.rating)} |`);

  const bestCost = rec.costs.find((c) => c.productId === best.product.id);
  if (bestCost) {
    lines.push("", "**What you'll actually pay (my pick)**");
    lines.push(`- Known so far: ${bestCost.knownTotal ? new Intl.NumberFormat("en", { style: "currency", currency: bestCost.knownTotal.currency }).format(bestCost.knownTotal.amount) : "not confirmed"}`);
    if (bestCost.unknownCosts.length) lines.push(`- Still unknown: ${bestCost.unknownCosts.join("; ")}`);
  }

  lines.push("", "**Reasons you might skip each one**");
  for (const a of rec.avoidIf) lines.push(`- **${nameOf(rec, a.productId)}**: ${a.reasons.join("; ")}`);

  lines.push("", "**Links**");
  for (const l of rec.links) lines.push(`- [${l.name}](${l.url})${l.affiliate ? " _(affiliate link)_" : ""}`);

  const notable = rec.uncertainties.filter((u) => !/not stated|Warranty|Return policy|Shipping cost/i.test(u)).slice(0, 5);
  if (notable.length) lines.push("", "**Heads-up**", ...notable.map((u) => `- ${u}`));

  if (rec.status === "partial") lines.push("", "_Some research came back incomplete — see the notes above before you buy._");
  lines.push("", `_Prices and stock checked ${when}. They can change — confirm on the seller's page before buying._`);
  if (rec.disclosures.some((d) => /affiliate links/i.test(d))) lines.push("_Some links are affiliate links; they never change my ranking._");
  return lines.join("\n");
}
