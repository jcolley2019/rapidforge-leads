/**
 * RapidForge AI Core wrapper — the ONLY seam between agents and Claude.
 *
 * App code NEVER imports the Anthropic SDK and NEVER fetches
 * api.anthropic.com directly (CLAUDE.md Section 4). All calls route through
 * RapidForge AI Core (github.com/jcolley2019/rapidforge-ai-core, pinned by
 * commit in apps/worker/package.json).
 */
import {
  AnthropicProvider,
  type ContentPart,
  type Message,
} from "@rapidforge/ai-core";
import { forceFixtures } from "./env";

// Model assignments (CLAUDE.md 4.1 — retired names appear nowhere).
/** Filter edge-pass; cheap classification. */
export const MODEL_HAIKU = "claude-haiku-4-5";
/** Audit summaries, Design (vision), Reputation, SEO, Sales Summary, Keyword Parser. */
export const MODEL_SONNET = "claude-sonnet-4-6";
/**
 * Top-tier synthesis — Analyst + Builder Brief (Sprint 8). Opus is the
 * PRIMARY so the stack never depends on Fable 5's availability. Thinking is
 * tuned via output_config.effort (we run these at effort "low").
 */
export const MODEL_OPUS = "claude-opus-4-8";
/**
 * Fable 5 — an OPTIONAL alternative for Analyst/Builder Brief (not selected by
 * default since Sprint 8). If ever used, a stop_reason "refusal" retries the
 * identical request on Opus (below). Adaptive thinking always on; temp unset.
 */
export const MODEL_FABLE = "claude-fable-5";
/** Refusal fallback for Fable 5 — the same model id as MODEL_OPUS. */
export const MODEL_FABLE_FALLBACK = "claude-opus-4-8";

/** Image input for vision calls (Design agent, PRD 6.8). */
export interface AiImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded bytes — no data: prefix, no newlines. */
  dataBase64: string;
}

export interface AiCallOptions {
  model:
    | typeof MODEL_HAIKU
    | typeof MODEL_SONNET
    | typeof MODEL_OPUS
    | typeof MODEL_FABLE
    | typeof MODEL_FABLE_FALLBACK;
  system?: string;
  prompt: string;
  /** Vision inputs — placed before the prompt text (Sonnet vision, PRD 6.8). */
  images?: AiImage[];
  maxTokens?: number;
  /**
   * Adaptive-thinking effort for the thinking models (Opus, Fable 5) —
   * controls cost, not a temperature. Forwarded to AI Core as
   * output_config.effort (v0.3.0+); the Anthropic adapter emits it and leaves
   * temperature unset. Inert for Sonnet/Haiku, which ignore output_config.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
 * Model pricing in CENTS PER MILLION TOKENS (input / output) — used to
 * compute cost_cents on every call (CLAUDE.md 6.5/8). Values from the
 * Claude API pricing table, 2026-06. Matched by model-id prefix; unknown
 * models bill at the Fable rate so cost is never understated.
 */
const MODEL_PRICING_CENTS_PER_MTOK: ReadonlyArray<
  [prefix: string, input: number, output: number]
> = [
  [MODEL_HAIKU, 100, 500],
  [MODEL_SONNET, 300, 1_500],
  [MODEL_FABLE, 1_000, 5_000],
  [MODEL_FABLE_FALLBACK, 500, 2_500],
];

/** Integer cents (agent_runs/usage_events columns are int), rounded UP. */
export function computeCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const row = MODEL_PRICING_CENTS_PER_MTOK.find(([prefix]) =>
    model.startsWith(prefix),
  );
  const [, inRate, outRate] = row ?? ["", 1_000, 5_000];
  return Math.ceil((inputTokens * inRate + outputTokens * outRate) / 1_000_000);
}

/** Default output budget — strict-JSON agent replies, not essays. */
const DEFAULT_MAX_TOKENS = 2048;

/** One retry on transient provider failures is handled by AI Core itself. */
const provider = new AnthropicProvider();

function buildMessages(options: AiCallOptions): Message[] {
  const messages: Message[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  if (options.images && options.images.length > 0) {
    const parts: ContentPart[] = [
      ...options.images.map((image) => ({
        type: "image" as const,
        mediaType: image.mediaType,
        data: image.dataBase64,
      })),
      { type: "text" as const, text: options.prompt },
    ];
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: options.prompt });
  }
  return messages;
}

/**
 * Call a Claude model via RapidForge AI Core (the ONLY Anthropic path —
 * CLAUDE.md Section 4). Fable 5 refusals arrive as HTTP 200 with
 * stop_reason "refusal" (AI Core maps it to finishReason
 * "content_filter") — the IDENTICAL request retries on claude-opus-4-8
 * per CLAUDE.md 4.1; tokens/cost of both attempts are summed.
 */
export async function callModel(options: AiCallOptions): Promise<AiCallResult> {
  const runOnce = async (model: AiCallOptions["model"]) => {
    const response = await provider.complete({
      messages: buildMessages(options),
      model,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.effort ? { outputConfig: { effort: options.effort } } : {}),
    });
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    return {
      text: response.text,
      modelUsed: response.model,
      tokensUsed: response.usage?.totalTokens ?? 0,
      costCents: computeCostCents(response.model, inputTokens, outputTokens),
      stopReason: mapStopReason(response.finishReason),
    } satisfies AiCallResult;
  };

  const first = await runOnce(options.model);
  if (options.model === MODEL_FABLE && first.stopReason === "refusal") {
    console.warn(
      "[ai] fable-5 refusal — retrying identical request on claude-opus-4-8 (CLAUDE.md 4.1)",
    );
    const second = await runOnce(MODEL_FABLE_FALLBACK);
    return {
      ...second,
      tokensUsed: first.tokensUsed + second.tokensUsed,
      costCents: first.costCents + second.costCents,
    };
  }
  return first;
}

function mapStopReason(
  finishReason: "stop" | "length" | "content_filter" | "other" | undefined,
): string {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "unknown";
  }
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
  /** Vision inputs forwarded to callModel (Design agent, PRD 6.8). */
  images?: AiImage[];
  maxTokens?: number;
  /** Fable 5 adaptive-thinking effort forwarded to callModel (Analyst/Brief). */
  effort?: AiCallOptions["effort"];
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
        ...(spec.images ? { images: spec.images } : {}),
        ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
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

// ---------------------------------------------------------------------------
// Markdown deliverable seam — the Builder Brief (PRD 6.12) is the one agent
// whose output is markdown, not strict JSON. Same guardrail protocol as
// generateJsonSummary, minus the JSON parse.
// ---------------------------------------------------------------------------

export interface MarkdownSpec {
  model: AiCallOptions["model"];
  system: string;
  prompt: string;
  images?: AiImage[];
  maxTokens?: number;
  effort?: AiCallOptions["effort"];
  guardrail: (markdown: string) => GuardrailResult;
  /** Deterministic fallback — template mode AND terminal AI failures. */
  template: () => string;
}

export interface MarkdownOutcome {
  value: string;
  modelUsed: string | null;
  tokensUsed: number;
  costCents: number;
  guardrailPassed: boolean;
  guardrailNotes: string | null;
}

/** Remove a wrapping ```markdown … ``` fence if the whole reply is fenced. */
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  const inner = match?.[1];
  return inner !== undefined ? inner.trim() : trimmed;
}

/**
 * Guardrail protocol (CLAUDE.md 6.2) for a markdown deliverable: run → fail →
 * re-run once → on the second failure persist flagged; any hard AI failure
 * falls back to the deterministic template so the deliverable always exists.
 */
export async function generateMarkdown(
  spec: MarkdownSpec,
): Promise<MarkdownOutcome> {
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
  let flagged: { value: string; modelUsed: string; notes: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: AiCallResult;
    try {
      result = await callModel({
        model: spec.model,
        system: spec.system,
        prompt: spec.prompt,
        ...(spec.images ? { images: spec.images } : {}),
        ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
      });
    } catch (err) {
      lastFailure = `AI call failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    tokensUsed += result.tokensUsed;
    costCents += result.costCents;
    const value = stripMarkdownFence(result.text);
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
