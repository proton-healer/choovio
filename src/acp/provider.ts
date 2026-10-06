/**
 * Choovio ACP provider loop (agent-driven provider workflow).
 *
 * `acp serve` is documented on os.virtuals.io but is not present in the
 * published CLI (checked: @virtuals-protocol/acp-cli 1.0.40), so Choovio uses
 * the documented "Approach 2: Agent-Driven" flow:
 *
 *   acp events listen → drain → on requirement: validate
 *     ├─ invalid → message the client why, do NOT set a budget (no funds are escrowed; job expires)
 *     └─ valid   → acp provider set-budget <price>
 *   job.funded → run research (≤ SLA) → acp provider submit <deliverable JSON>
 *     └─ research insufficient → deliverable says so explicitly (status "insufficient"), and we message the
 *        client recommending rejection, which returns their escrow. We never claim success we can't back up.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { createLlmHelper } from "../research/llm.js";
import { LiveFetcher } from "../research/fetcher.js";
import { liveFx } from "../research/fx.js";
import { createSearchProvider } from "../research/search.js";
import { runComparison } from "../pipeline.js";
import type { ParseInput } from "../research/intent.js";
import type { Recommendation } from "../types.js";
import { NodeAcpCli, type AcpCli } from "./cli.js";
import { toDeliverable, validateRequirement, type Requirement } from "./offering.js";

export interface AcpEvent {
  jobId: string;
  chainId: number | string;
  status: string;
  roles?: string[];
  availableTools?: string[];
  entry: {
    kind: "system" | "message";
    event?: { type: string; reason?: string; [k: string]: unknown };
    contentType?: string;
    content?: string;
    from?: string;
  };
}

type JobPhase = "awaiting_requirement" | "declined" | "budget_set" | "working" | "submitted" | "completed" | "rejected" | "expired" | "failed";

interface JobState {
  jobId: string;
  chainId: string;
  phase: JobPhase;
  requirement?: Requirement;
  declineReasons?: string[];
  resultStatus?: string;
  updatedAt: string;
  error?: string;
}

export type Researcher = (req: Requirement) => Promise<Recommendation>;

export const MAX_DELIVERABLE_CHARS = 24_000; // stays well under OS command-line limits

/** Shrink the deliverable progressively while keeping the decision-relevant facts. */
export function compactDeliverable(obj: ReturnType<typeof toDeliverable>, max = MAX_DELIVERABLE_CHARS): string {
  let d = structuredClone(obj);
  let s = JSON.stringify(d);
  const steps: ((x: typeof d) => void)[] = [
    (x) => x.products.forEach((p) => (p.specs = p.specs.slice(0, 5))),
    (x) => x.products.forEach((p) => (p.reviews = p.reviews.slice(0, 2))),
    (x) => x.products.forEach((p) => (p.complaints = p.complaints.slice(0, 2))),
    (x) => (x.sources = x.sources.slice(0, 15)),
    (x) => (x.uncertainties = x.uncertainties.slice(0, 15)),
    (x) => x.products.forEach((p) => (p.specs = [])),
    (x) => (x.summary_markdown = x.summary_markdown.slice(0, 3000)),
  ];
  for (const step of steps) {
    if (s.length <= max) break;
    step(d);
    s = JSON.stringify(d);
  }
  if (s.length > max) {
    d = { ...d, products: [], summary_markdown: d.summary_markdown.slice(0, 1500) };
    s = JSON.stringify({ ...d, note: "Deliverable truncated for size; product details omitted." });
  }
  return s;
}

export class ChoovioProvider {
  private jobs = new Map<string, JobState>();
  private busy = new Set<string>();

  constructor(
    private readonly cli: AcpCli,
    private readonly research: Researcher,
    private readonly opts: { priceUsdc: number; stateFile?: string; log?: (m: string) => void } = { priceUsdc: config.acp.priceUsdc },
  ) {
    this.load();
  }

  private log(m: string) {
    (this.opts.log ?? ((x: string) => console.log(`[choovio-provider] ${new Date().toISOString()} ${x}`)))(m);
  }

  private load() {
    const f = this.opts.stateFile;
    if (f && fs.existsSync(f)) {
      for (const j of JSON.parse(fs.readFileSync(f, "utf8")) as JobState[]) this.jobs.set(j.jobId, j);
    }
  }

  private save() {
    const f = this.opts.stateFile;
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify([...this.jobs.values()], null, 2));
  }

  job(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  private set(jobId: string, chainId: string, patch: Partial<JobState>) {
    const prev = this.jobs.get(jobId) ?? { jobId, chainId, phase: "awaiting_requirement" as JobPhase, updatedAt: "" };
    this.jobs.set(jobId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    this.save();
  }

  private async message(jobId: string, chainId: string, content: string) {
    try {
      await this.cli.run(["message", "send", "--job-id", jobId, "--chain-id", chainId, "--content", content, "--content-type", "text"]);
    } catch (e) {
      this.log(`job ${jobId}: message failed: ${(e as Error).message}`);
    }
  }

  async handle(ev: AcpEvent): Promise<void> {
    const jobId = String(ev.jobId);
    const chainId = String(ev.chainId);
    if (ev.roles && !ev.roles.map((r) => r.toLowerCase()).includes("provider")) return;
    const state = this.jobs.get(jobId);
    const tools = ev.availableTools ?? [];
    const type = ev.entry.kind === "system" ? ev.entry.event?.type : undefined;

    if (type === "job.completed" || type === "job.rejected" || type === "job.expired") {
      const phase = type.split(".")[1] as JobPhase;
      this.set(jobId, chainId, { phase });
      this.log(`job ${jobId}: ${phase}${ev.entry.event?.reason ? ` (${ev.entry.event.reason})` : ""}`);
      return;
    }

    // 1. Requirement arrives → validate before accepting work.
    if (ev.entry.kind === "message" && ev.entry.contentType === "requirement" && (!state || state.phase === "awaiting_requirement")) {
      await this.onRequirement(jobId, chainId, ev.entry.content ?? "", tools);
      return;
    }

    // 2. Funded → do the work.
    if ((type === "job.funded" || ev.status === "funded") && tools.includes("submit")) {
      if (state?.phase === "submitted" || this.busy.has(jobId)) return;
      await this.onFunded(jobId, chainId);
    }
  }

  private async onRequirement(jobId: string, chainId: string, content: string, tools: string[]) {
    const v = validateRequirement(content);
    if (!v.ok) {
      this.set(jobId, chainId, { phase: "declined", declineReasons: v.errors });
      this.log(`job ${jobId}: declined — ${v.errors.join("; ")}`);
      await this.message(
        jobId,
        chainId,
        `Choovio can't take this job as submitted, so no budget was set and no funds were requested. ${v.errors.join(" ")} Please create a new job with the corrected details.`,
      );
      return;
    }
    if (!tools.includes("setBudget")) {
      this.set(jobId, chainId, { phase: "awaiting_requirement", requirement: v.value });
      return;
    }
    await this.cli.run(["provider", "set-budget", "--job-id", jobId, "--amount", String(this.opts.priceUsdc), "--chain-id", chainId]);
    this.set(jobId, chainId, { phase: "budget_set", requirement: v.value });
    this.log(`job ${jobId}: budget set to ${this.opts.priceUsdc} USDC`);
  }

  private async onFunded(jobId: string, chainId: string) {
    let state = this.jobs.get(jobId);
    if (!state?.requirement) {
      // Requirement may have been missed (e.g. restart). Recover it from job history.
      try {
        const history = (await this.cli.run(["job", "history", "--job-id", jobId, "--chain-id", chainId])) as { messages?: { contentType?: string; content?: string }[]; entries?: { contentType?: string; content?: string }[] };
        const msgs = history.messages ?? history.entries ?? [];
        const req = msgs.find((m) => m.contentType === "requirement");
        const v = req ? validateRequirement(req.content ?? "") : null;
        if (v?.ok) this.set(jobId, chainId, { requirement: v.value });
      } catch (e) {
        this.log(`job ${jobId}: could not load history: ${(e as Error).message}`);
      }
      state = this.jobs.get(jobId);
    }
    if (!state?.requirement) {
      const deliverable = JSON.stringify({ agent: "Choovio", status: "insufficient", error: "The job's requirement could not be read, so no research was done. Please reject this job to recover your escrow." });
      await this.cli.run(["provider", "submit", "--job-id", jobId, "--deliverable", deliverable, "--chain-id", chainId]);
      this.set(jobId, chainId, { phase: "submitted", resultStatus: "insufficient" });
      return;
    }

    this.busy.add(jobId);
    this.set(jobId, chainId, { phase: "working" });
    try {
      const rec = await this.research(state.requirement);
      const deliverable = compactDeliverable(toDeliverable(rec));
      await this.cli.run(["provider", "submit", "--job-id", jobId, "--deliverable", deliverable, "--chain-id", chainId]);
      this.set(jobId, chainId, { phase: "submitted", resultStatus: rec.status });
      this.log(`job ${jobId}: submitted (${rec.status})`);
      if (rec.status === "insufficient") {
        await this.message(jobId, chainId, "Choovio could not verify enough facts to make a trustworthy recommendation (see 'uncertainties' in the deliverable). We recommend rejecting this job so your escrow is returned.");
      } else if (rec.status === "partial") {
        await this.message(jobId, chainId, "Heads-up: some research came back incomplete. The deliverable lists exactly what could not be verified.");
      }
    } catch (e) {
      const err = (e as Error).message;
      this.log(`job ${jobId}: research failed — ${err}`);
      const deliverable = JSON.stringify({ agent: "Choovio", status: "insufficient", error: `Research failed: ${err.slice(0, 300)}`, advice: "Please reject this job to recover your escrow." });
      try {
        await this.cli.run(["provider", "submit", "--job-id", jobId, "--deliverable", deliverable, "--chain-id", chainId]);
        this.set(jobId, chainId, { phase: "submitted", resultStatus: "insufficient", error: err });
      } catch (e2) {
        this.set(jobId, chainId, { phase: "failed", error: `${err}; submit failed: ${(e2 as Error).message}` });
      }
    } finally {
      this.busy.delete(jobId);
    }
  }
}

/** Map a validated requirement onto the pipeline's parse input. */
export function requirementToInput(req: Requirement): ParseInput {
  return {
    text: req.request ?? "",
    urls: req.product_urls ?? [],
    budget: req.budget ?? null,
    currency: req.currency ?? null,
    country: req.delivery_country,
    preferences: req.preferences ?? [],
  };
}

/** Default researcher: live search + safe fetching + optional LLM, bounded by the SLA (or a tighter deadline). */
export function liveResearcher(opts: { deadlineMs?: number } = {}): Researcher {
  const search = createSearchProvider();
  const llm = createLlmHelper();
  const fetcher = new LiveFetcher();
  const deadlineMs = opts.deadlineMs ?? Math.min(config.researchDeadlineMs, config.acp.slaMinutes * 60_000 - 45_000);
  return async (req) => {
    const result = await runComparison(requirementToInput(req), { fetcher, search, llm, fx: liveFx, deadlineMs });
    if (result.type === "questions") {
      // ACP jobs are one-shot: missing info means we can't complete — report it honestly.
      const { buildRecommendation } = await import("../recommend/build.js");
      return buildRecommendation({
        request: result.request,
        ranked: [],
        dataMode: "live",
        checkedAt: new Date().toISOString(),
        failures: [],
        notes: result.questions.map((q) => `Missing information: ${q.question}`),
      });
    }
    return result.recommendation;
  };
}

async function drainLoop(cli: AcpCli, provider: ChoovioProvider) {
  const file = config.acp.eventsFile;
  for (;;) {
    try {
      if (fs.existsSync(file)) {
        const res = (await cli.run(["events", "drain", "--file", file, "--limit", "20"])) as { events?: AcpEvent[] };
        for (const ev of res.events ?? []) {
          provider.handle(ev).catch((e) => console.error(`[choovio-provider] handler error: ${(e as Error).message}`));
        }
      }
    } catch (e) {
      console.error(`[choovio-provider] drain error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, config.acp.drainIntervalMs));
  }
}

async function main() {
  const cli = new NodeAcpCli();
  const who = (await cli.run(["agent", "whoami"])) as { name?: string; walletAddress?: string; offerings?: { name: string; priceValue: number }[] };
  console.log(`[choovio-provider] active agent: ${who.name} (${who.walletAddress})`);
  const offering = who.offerings?.find((o) => o.name === config.acp.offeringName);
  if (!offering) console.warn(`[choovio-provider] WARNING: offering "${config.acp.offeringName}" is not registered yet. Run: npm run offering:register -- --apply`);
  if (!createSearchProvider()) console.warn("[choovio-provider] WARNING: no search provider key set — only jobs with product_urls can be fully researched.");
  const price = offering?.priceValue ?? config.acp.priceUsdc;
  const provider = new ChoovioProvider(cli, liveResearcher(), { priceUsdc: price, stateFile: config.acp.stateFile });
  const listener = cli.spawnListener(config.acp.eventsFile);
  listener.on("exit", (code) => {
    console.error(`[choovio-provider] event listener exited (${code}); stopping.`);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    listener.kill();
    process.exit(0);
  });
  console.log(`[choovio-provider] listening for jobs; price ${price} USDC, SLA ${config.acp.slaMinutes} min`);
  await drainLoop(cli, provider);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
