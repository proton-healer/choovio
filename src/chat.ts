/**
 * Conversational wrapper: keeps a small draft between turns so Choovio can ask
 * only what's missing and fold the answers back in.
 */
import { z } from "zod";
import { normalizeCountry, parseBudget, parseCountry } from "./research/intent.js";
import { runComparison, type PipelineDeps } from "./pipeline.js";
import type { ClarifyingQuestion, Recommendation } from "./types.js";

export const DraftSchema = z.object({
  text: z.string().max(4000).default(""),
  country: z.string().max(60).nullable().default(null),
  budget: z.number().positive().nullable().default(null),
  currency: z.string().max(3).nullable().default(null),
  preferences: z.array(z.string().max(120)).max(12).default([]),
  pending: z.array(z.enum(["budget", "country", "use", "space", "query"])).default([]),
});
export type Draft = z.infer<typeof DraftSchema>;

export type ChatReply =
  | { type: "questions"; message: string; questions: ClarifyingQuestion[]; draft: Draft }
  | { type: "recommendation"; recommendation: Recommendation; draft: null };

/** Interpret a short follow-up answer against the questions we asked. */
export function applyAnswer(draft: Draft, message: string): Draft {
  const next: Draft = { ...draft, preferences: [...draft.preferences] };
  let consumed = false;
  if (draft.pending.includes("country")) {
    const c = normalizeCountry(message.trim()) ?? parseCountry(message) ?? normalizeCountry(message.trim().split(/[,\s]+/)[0]);
    if (c && c.length === 2 && /^[A-Z]{2}$/.test(c)) {
      next.country = c;
      consumed = true;
    }
  }
  if (draft.pending.includes("budget")) {
    const b = parseBudget(message);
    if (b.budget) {
      next.budget = b.budget.max;
      next.currency = b.currency ?? next.currency;
      consumed = true;
    } else {
      const n = /(\d+(?:[.,]\d{1,2})?)/.exec(message);
      if (n) {
        next.budget = Number(n[1]!.replace(",", "."));
        consumed = true;
      }
    }
  }
  if (draft.pending.includes("use")) {
    // Whatever they said about use/interests is a preference, minus a leading country answer ("UK, he loves…").
    const pref = message.replace(/^\s*(the\s+)?(usa|us|uk|gb|united states|united kingdom|[a-z]{2})\s*[,.;:-]\s*/i, "").trim();
    if (pref) next.preferences = [...new Set([...next.preferences, pref.slice(0, 120)])];
  }
  if (draft.pending.includes("use") || draft.pending.includes("space") || draft.pending.includes("query") || !consumed) {
    next.text = `${draft.text} ${message}`.trim();
  }
  next.pending = [];
  return next;
}

export async function chatTurn(message: string, draftIn: Draft | null, deps: PipelineDeps): Promise<ChatReply> {
  const draft: Draft = draftIn ? applyAnswer(draftIn, message) : { ...DraftSchema.parse({}), text: message };
  const result = await runComparison(
    {
      text: draft.text,
      country: draft.country,
      budget: draft.budget,
      currency: draft.currency,
      preferences: draft.preferences,
    },
    deps,
  );
  if (result.type === "questions") {
    const intro = result.questions.length === 1 ? "Quick question before I start looking:" : "A couple of quick questions so I don't waste your time:";
    return {
      type: "questions",
      message: intro,
      questions: result.questions,
      draft: { ...draft, country: result.request.country, currency: result.request.currency, budget: result.request.budget?.max ?? draft.budget, pending: result.questions.map((q) => q.field) },
    };
  }
  return { type: "recommendation", recommendation: result.recommendation, draft: null };
}
