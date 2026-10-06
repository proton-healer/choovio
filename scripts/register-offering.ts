/**
 * Register (or update) the "Shopping Comparison" ACP offering for the active agent.
 *
 *   npm run offering:register              # dry run: writes economyos/offering.json and prints the command
 *   npm run offering:register -- --apply   # actually creates/updates the offering via the acp CLI
 *
 * Registering an offering costs nothing, but it makes Choovio publicly hireable,
 * so it is opt-in. Price comes from CHOOVIO_PRICE_USDC (default 0.5 USDC).
 */
import fs from "node:fs";
import path from "node:path";
import { NodeAcpCli } from "../src/acp/cli.js";
import { offeringConfig } from "../src/acp/offering.js";

const apply = process.argv.includes("--apply");
const o = offeringConfig();
const outFile = path.resolve("economyos", "offering.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(o, null, 2) + "\n");

const args = [
  "offering", "create",
  "--name", o.name,
  "--description", o.description,
  "--price-type", o.priceType,
  "--price-value", String(o.priceValue),
  "--sla-minutes", String(o.slaMinutes),
  "--requirements", JSON.stringify(o.requirements),
  "--deliverable", o.deliverable,
  "--no-required-funds",
  o.hidden ? "--hidden" : "--no-hidden",
];

console.log(`Offering config written to ${path.relative(process.cwd(), outFile)}`);
console.log(`  ${o.name}: ${o.priceValue} USDC, SLA ${o.slaMinutes} min`);

if (!apply) {
  console.log("\nDry run. To register, run:\n  npm run offering:register -- --apply\n");
  console.log("Equivalent CLI call:\n  acp " + args.map((a) => (/[\s"{}$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ") + " --json");
  process.exit(0);
}

const cli = new NodeAcpCli();
const existing = ((await cli.run(["offering", "list"])) as { id: string; name: string }[]).find((x) => x.name === o.name);
if (existing) {
  const updateArgs = ["offering", "update", "--offering-id", existing.id, ...args.slice(2).filter((a) => a !== "--no-required-funds" && a !== "--no-hidden" && a !== "--hidden")];
  console.log(JSON.stringify(await cli.run(updateArgs), null, 2));
  console.log(`Updated offering ${existing.id}`);
} else {
  console.log(JSON.stringify(await cli.run(args), null, 2));
  console.log("Offering created.");
}
