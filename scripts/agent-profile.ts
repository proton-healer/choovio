/**
 * Sync the EconomyOS agent profile (economyos/agent-profile.json) to the active agent.
 *
 *   npm run agent:profile              # dry run: shows what would change
 *   npm run agent:profile -- --apply   # runs `acp agent update`
 */
import fs from "node:fs";
import { NodeAcpCli } from "../src/acp/cli.js";

const apply = process.argv.includes("--apply");
const profile = JSON.parse(fs.readFileSync("economyos/agent-profile.json", "utf8")) as { name: string; description: string; imageUrl?: string };
const cli = new NodeAcpCli();
const who = (await cli.run(["agent", "whoami"])) as { id: string; name: string; description: string; imageUrl?: string; walletAddress: string };

console.log(`Active agent: ${who.name} (${who.id}) wallet ${who.walletAddress}`);
const args = ["agent", "update"];
if (who.name !== profile.name) args.push("--name", profile.name);
if (who.description !== profile.description) args.push("--description", profile.description);
if (profile.imageUrl && who.imageUrl !== profile.imageUrl) args.push("--image", profile.imageUrl);

if (args.length === 2) {
  console.log("Profile already up to date.");
} else if (!apply) {
  console.log("Changes pending (dry run):", args.slice(2).filter((_, i) => i % 2 === 0).join(", "));
  console.log("Run with --apply to update.");
} else {
  console.log(JSON.stringify(await cli.run(args), null, 2));
}
