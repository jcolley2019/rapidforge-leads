/**
 * RapidForge AI Core wrapper — the ONLY seam between agents and Claude.
 *
 * App code NEVER imports the Anthropic SDK and NEVER fetches
 * api.anthropic.com directly (CLAUDE.md Section 4). All calls route through
 * RapidForge AI Core (github.com/jcolley2019/rapidforge-ai-core, local at
 * C:\Users\jcoll\OneDrive\Desktop\rapidforge-ai-core).
 */
import { forceFixtures } from "./env";

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
    "RapidForge AI Core wrapper is not wired yet (Sprint 0 pending). No agent may call Anthropic directly — see TODOs in lib/ai.ts.",
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 AI seam — Sonnet summaries with a deterministic template fallback
// ---------------------------------------------------------------------------

/**
 * Summary mode: 'core' routes through RapidForge AI Core when
 * ANTHROPIC_API_KEY is present; 'template' produces deterministic
 * summaries built from the measured data (numbers included), so the
 * pipeline is fully functional with zero keys.
 */
export function aiSummaryMode(): "core" | "template" {
  if (forceFixtures()) return "template";
  return process.env.ANTHROPIC_API_KEY ? "core" : "template";
}

/** Pure guardrail verdict (CLAUDE.md 6.2). */
export interface GuardrailResult {
  passed: boolean;
  notes: string | null;
}

export interface SummarySpec<T> {
  model: AiCallOptions["model"];
  system: string;
  prompt: string;
  /** Zod-parse the model's strict-JSON reply (CLAUDE.md 6.1). */
  parse: (raw: string) => T;
  guardrail: (value: T) => GuardrailResult;
  /** Deterministic fallback — template mode AND terminal AI failures. */
  template: () => T;
}

export interface SummaryOutcome<T> {
  value: T;
  /** Null when the deterministic template answered. */
  modelUsed: string | null;
  tokensUsed: number;
  costCents: number;
  guardrailPassed: boolean;
  guardrailNotes: string | null;
}

/** Strip markdown fences some models wrap around JSON. */
export function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Guardrail protocol (CLAUDE.md 6.2): run → fail → re-run once → on the
 * second failure persist flagged (guardrail_passed:false + notes), never
 * silently accept bad output, never stall the job. Any hard AI failure
 * (unwired Core, network, unparseable JSON twice) falls back to the
 * deterministic template so the audit always completes.
 */
export async function generateJsonSummary<T>(
  spec: SummarySpec<T>,
): Promise<SummaryOutcome<T>> {
  if (aiSummaryMode() === "template") {
    const value = spec.template();
    const verdict = spec.guardrail(value);
    return {
      value,
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      guardrailPassed: verdict.passed,
      guardrailNotes: verdict.notes,
    };
  }

  let tokensUsed = 0;
  let costCents = 0;
  let lastFailure = "";
  let flagged: { value: T; modelUsed: string; notes: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: AiCallResult;
    try {
      result = await callModel({
        model: spec.model,
        system: spec.system,
        prompt: spec.prompt,
      });
    } catch (err) {
      lastFailure = `AI call failed: ${err instanceof Error ? err.message : String(err)}`;
      break; // transport/wiring failure — retrying won't change it
    }
    tokensUsed += result.tokensUsed;
    costCents += result.costCents;
    let value: T;
    try {
      value = spec.parse(stripJsonFences(result.text));
    } catch (err) {
      lastFailure = `Unparseable model output: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const verdict = spec.guardrail(value);
    if (verdict.passed) {
      return {
        value,
        modelUsed: result.modelUsed,
        tokensUsed,
        costCents,
        guardrailPassed: true,
        guardrailNotes: null,
      };
    }
    lastFailure = verdict.notes ?? "guardrail failed";
    flagged = {
      value,
      modelUsed: result.modelUsed,
      notes: `Guardrail failed twice: ${lastFailure}`,
    };
  }

  if (flagged) {
    // Valid JSON that failed guardrails twice — persist flagged for review.
    return {
      value: flagged.value,
      modelUsed: flagged.modelUsed,
      tokensUsed,
      costCents,
      guardrailPassed: false,
      guardrailNotes: flagged.notes,
    };
  }

  const value = spec.template();
  return {
    value,
    modelUsed: null,
    tokensUsed,
    costCents,
    guardrailPassed: false,
    guardrailNotes: `Fell back to deterministic template — ${lastFailure}`,
  };
}
