/**
 * RapidForge AI Core wrapper — the ONLY seam between agents and Claude.
 *
 * App code NEVER imports the Anthropic SDK and NEVER fetches
 * api.anthropic.com directly (CLAUDE.md Section 4). All calls route through
 * RapidForge AI Core (github.com/jcolley2019/rapidforge-ai-core, pinned by
 * release tag in apps/worker/package.json).
 *
 * RFL.AI.9 (ai-core v0.9.0):
 *   - Retries live in ONE layer: the provider (`maxRetries: 2`). Nothing
 *     here re-issues a failed transport call.
 *   - Strict-JSON agents use structured output: `outputConfig.format` built
 *     from the agent's Zod schema, `parseJson` to validate, and
 *     `OutputParseError.reason` mapped onto the fallback paths.
 *   - A refusal (`stop_reason: "refusal"`, HTTP 200) on ANY model retries the
 *     identical request on MODEL_REFUSAL_FALLBACK once (finding 20).
 *   - Cost comes from ai-core's price table (`estimateCostUsd`), carried as
 *     exact integer microcents; `cost_cents` is derived. An unknown model id
 *     records tokens and a null cost — never a guess (finding 19).
 *   - The stage budget's AbortSignal (RFL.QUEUE.8) is the request signal.
 */
import {
  AnthropicProvider,
  estimateCostUsd,
  jsonSchemaFormat,
  OutputParseError,
  parseJson,
  PRICE_TABLE_DATE,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type JsonSchemaFormat,
  type Message,
  type TokenUsage,
} from "@rapidforge/ai-core";
import type { ZodType } from "zod";
import { forceFixtures } from "./env";

// Model assignments (CLAUDE.md 4.1 — retired names appear nowhere).
/** Filter edge-pass, cheap classification, and the five narration summaries when AI_SUMMARIES=haiku. */
export const MODEL_HAIKU = "claude-haiku-4-5";
/** Design (vision), Sales Summary, Analyst — all at effort "low". */
export const MODEL_SONNET = "claude-sonnet-5-5";
/** Builder Brief (effort "low") and the refusal fallback for every model. */
export const MODEL_OPUS = "claude-opus-4-8";
/** Fable 5 — an OPTIONAL alternative for Analyst/Builder Brief; not selected by default. */
export const MODEL_FABLE = "claude-fable-5";
/**
 * Any model's `stop_reason: "refusal"` retries the identical request here
 * (CLAUDE.md 4.1 generalised per finding 20). Opus itself is never retried.
 */
export const MODEL_REFUSAL_FALLBACK = MODEL_OPUS;

export type ModelId =
  | typeof MODEL_HAIKU
  | typeof MODEL_SONNET
  | typeof MODEL_OPUS
  | typeof MODEL_FABLE;

/** Adaptive-thinking effort (Sonnet 5.5, Opus, Fable). Never sent for Haiku. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Image input for vision calls (Design agent, PRD 6.8). */
export interface AiImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded bytes — no data: prefix, no newlines. */
  dataBase64: string;
}

export interface AiCallOptions {
  model: ModelId;
  system?: string;
  prompt: string;
  /** Vision inputs — placed before the prompt text (PRD 6.8). */
  images?: AiImage[];
  maxTokens?: number;
  /**
   * Adaptive-thinking effort, forwarded as output_config.effort. ai-core
   * rejects it before any network call on models that do not take it
   * (Haiku 4.5), so callers only set it for Sonnet 5.5 / Opus / Fable.
   */
  effort?: Effort;
  /** Structured output: the JSON Schema the reply must satisfy. */
  format?: JsonSchemaFormat;
  /** The stage budget's signal (RFL.QUEUE.8): an abort cancels the request. */
  signal?: AbortSignal;
}

export interface AiCallResult {
  text: string;
  /** Model that actually answered (differs from requested after a fallback). */
  modelUsed: string;
  tokensUsed: number;
  /**
   * Exact list-price cost in microcents (1¢ = 1_000_000), summed over both
   * attempts after a refusal fallback. Null when ai-core has no price for
   * the model that answered.
   */
  costMicrocents: number | null;
  /** Anthropic's own stop reason (`end_turn` / `max_tokens` / `refusal` / …). */
  stopReason: string;
  /** The ai-core response, for `parseJson`. */
  response: CompletionResponse;
}

// ---------------------------------------------------------------------------
// Cost (finding 19): integer microcents in flight, cents derived at the edge
// ---------------------------------------------------------------------------

export const MICROCENTS_PER_CENT = 1_000_000;

/** Nearest cent (not ceil — per-call ceil was inflating summary spend 2×). */
export function centsFromMicrocents(microcents: number | null): number | null {
  return microcents === null ? null : Math.round(microcents / MICROCENTS_PER_CENT);
}

/**
 * Sum per-run costs for one audit. `undefined` (a deterministic agent that
 * carries no cost field) counts as 0; `null` (an unknown model) makes the
 * total unknown rather than understated.
 */
export function sumMicrocents(
  values: ReadonlyArray<number | null | undefined>,
): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v ?? 0;
  }
  return total;
}

/** Model ids already reported as unpriced — one log line per id per process. */
const unpricedModelsLogged = new Set<string>();

/** Microcents for one response, or null (logged once per model id) when ai-core has no price. */
export function costMicrocentsFor(model: string, usage: TokenUsage | undefined): number | null {
  const estimate = usage ? estimateCostUsd(model, usage) : undefined;
  if (!estimate) {
    if (!unpricedModelsLogged.has(model)) {
      unpricedModelsLogged.add(model);
      console.warn(
        `[ai] no list price for model ${model} (ai-core PRICE_TABLE ${PRICE_TABLE_DATE}) — recording tokens only, cost_cents null`,
      );
    }
    return null;
  }
  return Math.round(estimate.usd * 100 * MICROCENTS_PER_CENT);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** ai-core's own default; thinking tokens count against it on Sonnet 5.5 / Opus. */
export const DEFAULT_MAX_TOKENS = 4096;

/** The one retry layer (ai-core README "Timeouts and retries"): up to 3 attempts. */
export const PROVIDER_MAX_RETRIES = 2;

type Transport = Pick<AIProvider, "complete">;

function defaultProvider(): Transport {
  return new AnthropicProvider({ maxRetries: PROVIDER_MAX_RETRIES });
}

let provider: Transport = defaultProvider();
/** True while a test's fake provider is installed — the only way core mode runs under vitest. */
let fakeProviderInstalled = false;

/** Test seam: a fake provider (and a fresh unpriced-model log). Null restores the real one. */
export function setAiProviderForTests(fake: Transport | null): void {
  provider = fake ?? defaultProvider();
  fakeProviderInstalled = fake !== null;
  unpricedModelsLogged.clear();
}

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

function buildRequest(options: AiCallOptions, model: string): CompletionRequest {
  const outputConfig = {
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.format ? { format: options.format } : {}),
  };
  return {
    messages: buildMessages(options),
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(Object.keys(outputConfig).length > 0 ? { outputConfig } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function stopReasonOf(response: CompletionResponse): string {
  if (response.rawStopReason) return response.rawStopReason;
  switch (response.finishReason) {
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

async function runOnce(options: AiCallOptions, model: string): Promise<AiCallResult> {
  const response = await provider.complete(buildRequest(options, model));
  return {
    text: response.text,
    modelUsed: response.model,
    tokensUsed: response.usage?.totalTokens ?? 0,
    costMicrocents: costMicrocentsFor(response.model, response.usage),
    stopReason: stopReasonOf(response),
    response,
  };
}

/**
 * Call a Claude model via RapidForge AI Core (the ONLY Anthropic path —
 * CLAUDE.md Section 4). The provider retries transport failures itself;
 * nothing here does. A refusal (HTTP 200, stop_reason "refusal") on any
 * model other than the fallback retries the IDENTICAL request once on
 * MODEL_REFUSAL_FALLBACK; tokens/cost of both attempts are summed.
 */
export async function callModel(options: AiCallOptions): Promise<AiCallResult> {
  const first = await runOnce(options, options.model);
  if (first.stopReason !== "refusal" || options.model === MODEL_REFUSAL_FALLBACK) {
    return first;
  }
  const category = first.response.stopDetails?.category ?? "uncategorised";
  console.warn(
    `[ai] ${first.modelUsed} refused (${category}) — retrying identical request on ${MODEL_REFUSAL_FALLBACK} (CLAUDE.md 4.1)`,
  );
  const second = await runOnce(options, MODEL_REFUSAL_FALLBACK);
  return {
    ...second,
    tokensUsed: first.tokensUsed + second.tokensUsed,
    costMicrocents: sumMicrocents([first.costMicrocents, second.costMicrocents]),
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Summary mode: 'core' routes through RapidForge AI Core when
 * ANTHROPIC_API_KEY is present; 'template' produces deterministic
 * summaries built from the measured data (numbers included), so the
 * pipeline is fully functional with zero keys.
 * Under vitest it is 'template' unless a test installed a fake provider via
 * setAiProviderForTests — a real key never reaches the network (RFL.FIX.3a).
 */
export function aiSummaryMode(): "core" | "template" {
  if (forceFixtures()) return "template";
  if (process.env.VITEST && !fakeProviderInstalled) return "template";
  return process.env.ANTHROPIC_API_KEY ? "core" : "template";
}

/**
 * Narration summaries (Health, Conversion, Presence, Reputation, SEO) only
 * restate numbers the worker measured; their guardrails are mechanical and
 * the deterministic templates pass them (audit §e). They are template by
 * default; AI_SUMMARIES=haiku routes them to Haiku 4.5 (no effort).
 */
export function narrationSummaryMode(): "template" | "haiku" {
  return process.env.AI_SUMMARIES === "haiku" ? "haiku" : "template";
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * JSON Schema keywords the Messages API rejects in output_config.format
 * (ai-core README "Structured output"). The wire schema carries only the
 * shape; `parseJson` still enforces the full Zod schema locally, so a reply
 * outside a bound is a schema_mismatch, never silently accepted.
 */
const WIRE_UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (WIRE_UNSUPPORTED_KEYWORDS.has(key) && typeof value !== "object") continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

/** The agent's Zod schema as an API-safe output_config.format. */
export function wireFormat<T>(schema: ZodType<T>, name?: string): JsonSchemaFormat {
  const built = jsonSchemaFormat(schema, name);
  return {
    ...built,
    schema: stripUnsupported(built.schema) as Record<string, unknown>,
  };
}

/** Pure guardrail verdict (CLAUDE.md 6.2). */
export interface GuardrailResult {
  passed: boolean;
  notes: string | null;
}

export interface SummarySpec<T> {
  model: ModelId;
  /**
   * "narration" (default "judgment"): template unless AI_SUMMARIES=haiku
   * — see narrationSummaryMode. Narration specs name MODEL_HAIKU.
   */
  kind?: "judgment" | "narration";
  system: string;
  prompt: string;
  /** Vision inputs forwarded to callModel (Design agent, PRD 6.8). */
  images?: AiImage[];
  maxTokens?: number;
  /** Adaptive-thinking effort (Sonnet 5.5 / Opus / Fable only). */
  effort?: Effort;
  /** The reply's Zod schema: sent as output_config.format, enforced by parseJson. */
  schema: ZodType<T>;
  guardrail: (value: T) => GuardrailResult;
  /** Deterministic fallback — template mode AND terminal AI failures. */
  template: () => T;
  /** Stage budget signal (RFL.QUEUE.8). */
  signal?: AbortSignal;
}

export interface SummaryOutcome<T> {
  value: T;
  /** Null when the deterministic template answered. */
  modelUsed: string | null;
  tokensUsed: number;
  /** Exact spend; null when the answering model has no list price. */
  costMicrocents: number | null;
  /** Derived from costMicrocents (nearest cent); null when unknown. */
  costCents: number | null;
  guardrailPassed: boolean;
  guardrailNotes: string | null;
}

function templateOutcome<T>(spec: { template: () => T; guardrail: (v: T) => GuardrailResult }): SummaryOutcome<T> {
  const value = spec.template();
  const verdict = spec.guardrail(value);
  return {
    value,
    modelUsed: null,
    tokensUsed: 0,
    costMicrocents: 0,
    costCents: 0,
    guardrailPassed: verdict.passed,
    guardrailNotes: verdict.notes,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Guardrail protocol (CLAUDE.md 6.2) on top of structured output:
 *   call → parseJson → guardrail → pass.
 *   guardrail fail → re-run once → second fail persists flagged
 *     (guardrail_passed:false + notes); never silently accept bad output.
 *   OutputParseError.reason: refused → template (the model already got its
 *     one refusal fallback inside callModel); truncated → retry once with
 *     max_tokens doubled, then template; invalid_json / schema_mismatch →
 *     template. Transport errors → template (the provider already retried).
 * At most two model calls per summary; the audit always completes.
 */
export async function generateJsonSummary<T>(
  spec: SummarySpec<T>,
): Promise<SummaryOutcome<T>> {
  if (aiSummaryMode() === "template") return templateOutcome(spec);
  if (spec.kind === "narration" && narrationSummaryMode() === "template") {
    return templateOutcome(spec);
  }

  const format = wireFormat(spec.schema);
  let maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS;
  let tokensUsed = 0;
  let costMicrocents: number | null = 0;
  let lastFailure = "";
  let flagged: { value: T; modelUsed: string; notes: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: AiCallResult;
    try {
      result = await callModel({
        model: spec.model,
        system: spec.system,
        prompt: spec.prompt,
        format,
        maxTokens,
        ...(spec.images ? { images: spec.images } : {}),
        ...(spec.effort && spec.model !== MODEL_HAIKU ? { effort: spec.effort } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
    } catch (err) {
      lastFailure = `AI call failed: ${describeError(err)}`;
      break; // ai-core already retried what was retryable
    }
    tokensUsed += result.tokensUsed;
    costMicrocents = sumMicrocents([costMicrocents, result.costMicrocents]);

    let value: T;
    try {
      value = parseJson(result.response, spec.schema);
    } catch (err) {
      if (!(err instanceof OutputParseError)) {
        lastFailure = `Unparseable model output: ${describeError(err)}`;
        break;
      }
      if (err.reason === "truncated" && attempt === 1) {
        lastFailure = `Truncated at max_tokens ${maxTokens}`;
        maxTokens *= 2;
        continue;
      }
      lastFailure =
        err.reason === "refused"
          ? `Refused by ${result.modelUsed}${err.stopDetails?.category ? ` (${err.stopDetails.category})` : ""}`
          : err.reason === "truncated"
            ? `Truncated at max_tokens ${maxTokens} after one doubled retry`
            : `${err.reason}: ${err.message}`;
      break;
    }

    const verdict = spec.guardrail(value);
    if (verdict.passed) {
      return {
        value,
        modelUsed: result.modelUsed,
        tokensUsed,
        costMicrocents,
        costCents: centsFromMicrocents(costMicrocents),
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
      costMicrocents,
      costCents: centsFromMicrocents(costMicrocents),
      guardrailPassed: false,
      guardrailNotes: flagged.notes,
    };
  }

  const value = spec.template();
  return {
    value,
    modelUsed: null,
    tokensUsed,
    costMicrocents,
    costCents: centsFromMicrocents(costMicrocents),
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
  model: ModelId;
  system: string;
  prompt: string;
  images?: AiImage[];
  maxTokens?: number;
  effort?: Effort;
  guardrail: (markdown: string) => GuardrailResult;
  /** Deterministic fallback — template mode AND terminal AI failures. */
  template: () => string;
  signal?: AbortSignal;
}

export type MarkdownOutcome = SummaryOutcome<string>;

/** Remove a wrapping ```markdown … ``` fence if the whole reply is fenced. */
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  const inner = match?.[1];
  return inner !== undefined ? inner.trim() : trimmed;
}

/**
 * Guardrail protocol (CLAUDE.md 6.2) for a markdown deliverable: run → fail →
 * re-run once → on the second failure persist flagged. A refusal (after
 * callModel's fallback) or transport error falls back to the template; a
 * reply cut off at max_tokens retries once with the cap doubled.
 */
export async function generateMarkdown(
  spec: MarkdownSpec,
): Promise<MarkdownOutcome> {
  if (aiSummaryMode() === "template") return templateOutcome(spec);

  let maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS;
  let tokensUsed = 0;
  let costMicrocents: number | null = 0;
  let lastFailure = "";
  let flagged: { value: string; modelUsed: string; notes: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: AiCallResult;
    try {
      result = await callModel({
        model: spec.model,
        system: spec.system,
        prompt: spec.prompt,
        maxTokens,
        ...(spec.images ? { images: spec.images } : {}),
        ...(spec.effort && spec.model !== MODEL_HAIKU ? { effort: spec.effort } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
    } catch (err) {
      lastFailure = `AI call failed: ${describeError(err)}`;
      break;
    }
    tokensUsed += result.tokensUsed;
    costMicrocents = sumMicrocents([costMicrocents, result.costMicrocents]);
    if (result.stopReason === "refusal") {
      lastFailure = `Refused by ${result.modelUsed}${result.response.stopDetails?.category ? ` (${result.response.stopDetails.category})` : ""}`;
      break;
    }
    if (result.stopReason === "max_tokens" && attempt === 1) {
      lastFailure = `Truncated at max_tokens ${maxTokens}`;
      maxTokens *= 2;
      continue;
    }
    const value = stripMarkdownFence(result.text);
    const verdict = spec.guardrail(value);
    if (verdict.passed) {
      return {
        value,
        modelUsed: result.modelUsed,
        tokensUsed,
        costMicrocents,
        costCents: centsFromMicrocents(costMicrocents),
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
      costMicrocents,
      costCents: centsFromMicrocents(costMicrocents),
      guardrailPassed: false,
      guardrailNotes: flagged.notes,
    };
  }

  const value = spec.template();
  return {
    value,
    modelUsed: null,
    tokensUsed,
    costMicrocents,
    costCents: centsFromMicrocents(costMicrocents),
    guardrailPassed: false,
    guardrailNotes: `Fell back to deterministic template — ${lastFailure}`,
  };
}
