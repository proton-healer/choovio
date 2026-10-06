/**
 * Thin wrapper around the official `acp` CLI (@virtuals-protocol/acp-cli).
 *
 * The CLI owns authentication, the agent wallet and the P256 signer (in the OS
 * keychain). Choovio never sees private keys. We invoke the CLI's JS entry with
 * the current Node binary — no shell, so arguments can't be interpreted.
 */
import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface AcpCli {
  run(args: string[]): Promise<unknown>;
  spawnListener(outputFile: string): ChildProcess;
}

export function resolveCliEntry(): string {
  if (config.acp.cliPath) return config.acp.cliPath;
  const rel = path.join("@virtuals-protocol", "acp-cli", "dist", "bin", "acp.js");
  const nodeDir = path.dirname(process.execPath);
  const candidates = [path.join(nodeDir, "node_modules", rel), path.join(nodeDir, "..", "lib", "node_modules", rel)];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  const entry = path.join(root, rel);
  if (!fs.existsSync(entry)) throw new Error(`acp CLI not found at ${entry}. Install it: npm install -g @virtuals-protocol/acp-cli (or set ACP_CLI_PATH)`);
  return entry;
}

/** Read-only commands that are safe to retry on transient network errors. */
const RETRYABLE = new Set(["agent whoami", "agent list", "offering list", "job history", "job list"]);

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const line = trimmed.split(/\r?\n/).find((l) => l.startsWith("{") || l.startsWith("["));
    if (line) return JSON.parse(line);
    throw new Error(`Unexpected CLI output: ${trimmed.slice(0, 200)}`);
  }
}

export class AcpCliError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "AcpCliError";
  }
}

export class NodeAcpCli implements AcpCli {
  private entry = resolveCliEntry();

  async run(args: string[]): Promise<unknown> {
    const retryable = RETRYABLE.has(args.slice(0, 2).join(" "));
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce(args);
      } catch (e) {
        if (!retryable || attempt >= 4 || !/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  private runOnce(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [this.entry, ...args, "--json"], { maxBuffer: 10 * 1024 * 1024, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          let msg = stderr || stdout || err.message;
          let code: string | undefined;
          try {
            const parsed = parseJsonOutput(stdout || stderr) as { error?: string; code?: string };
            msg = parsed.error ?? msg;
            code = parsed.code;
          } catch {
            /* keep raw */
          }
          return reject(new AcpCliError(String(msg).trim().slice(0, 500), code));
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  spawnListener(outputFile: string): ChildProcess {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    return spawn(process.execPath, [this.entry, "events", "listen", "--output", outputFile, "--json"], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  }
}
