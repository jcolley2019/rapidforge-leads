/**
 * RapidForge AI Core wrapper — the ONLY seam between agents and Claude.
 *
 * App code NEVER imports the Anthropic SDK and NEVER fetches
 * api.anthropic.com directly (CLAUDE.md Section 4). All calls route through
 * RapidForge AI Core (github.com/jcolley2019/rapidforge-ai-core, local at
 * C:\Users\jcoll\OneDrive\Desktop\rapidforge-ai-core).
 */

// Model assignments (CLAUDE.md 4.1 — retired names appear nowhere).
/** Filter edge-pass; cheap classification. */
export const MODEL_HAIKU = "claude-haiku-4-5";
/** Audit summaries, Design (vision), Reputation, SEO, Sales Summary, Keyword Parser. */
export const MODEL_SONNET = "claude-sonnet-4-6";
/** Analyst + Builder Brief ONLY. Adaptive thinking always on; temperature 1.0 or unset. */
export const MODEL_FABLE = "claude-fable-5";
/** Automatic fallback when Fable 5 returns stop_reason "refusal". */
export const MODEL_FABLE_FALLBACK = "claude-opus-4-8";

export interface AiCallOptions {
  model:
    | typeof MODEL_HAIKU
    | typeof MODEL_SONNET
    | typeof MODEL_FABLE
    | typeof MODEL_FABLE_FALLBACK;
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** Fable 5 adaptive-thinking effort — controls cost, not a temperature. */
  effort?: "low" | "medium" | "high";
}

export interface AiCallResult {
  text: string;
  /** Model that actually answered (differs from requested after a fallback). */
  modelUsed: string;
  tokensUsed: number;
  costCents: number;
  stopReason: string;
}

/**
 * Call a Claude model via RapidForge AI Core.
 *
 * TODO(Sprint 2+): wire to the AI Core client once Sprint 0 confirms
 *   fable-5 support in that repo. Every call must log tokens_used +
 *   cost_cents to agent_runs and usage_events (CLAUDE.md 6.5).
 *
 * TODO(refusal-retry): Fable 5 refusals arrive as HTTP 200 with
 *   stop_reason "refusal" — retry the IDENTICAL request on
 *   claude-opus-4-8 (MODEL_FABLE_FALLBACK). Never crash, never stall a
 *   job on a refusal (CLAUDE.md 4.1).
 */
export async function callModel(_options: AiCallOptions): Promise<AiCallResult> {
  throw new Error(
    "RapidForge AI Core wrapper is not wired yet (Sprint 2+). No agent may call Anthropic directly — see TODOs in lib/ai.ts.",
  );
}
