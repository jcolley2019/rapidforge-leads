/**
 * The AI seam on ai-core v0.9.0 (RFL.AI.9), provider mocked: structured
 * output and the OutputParseError.reason mapping, the one-layer retry rule,
 * the generalised refusal fallback, cost from the price table (null for an
 * unknown id, logged once), the narration switch, and signal passthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@rapidforge/ai-core";
import { z } from "zod";
import {
  callModel,
  centsFromMicrocents,
  costMicrocentsFor,
  DEFAULT_MAX_TOKENS,
  generateJsonSummary,
  generateMarkdown,
  MODEL_HAIKU,
  MODEL_OPUS,
  MODEL_REFUSAL_FALLBACK,
  MODEL_SONNET,
  narrationSummaryMode,
  parseAiSummaries,
  sumMicrocents,
  wireFormat,
  type MarkdownSpec,
  type SummarySpec,
} from "./ai";
import {
  coreModeEnv,
  fakeProvider,
  FAKE_USAGE,
  jsonReply,
  refusalReply,
  truncatedReply,
} from "./ai.testkit";

const Reply = z.object({
  score: z.number().int().min(0).max(100),
  notes: z.array(z.string().min(1)).min(1),
});
type Reply = z.infer<typeof Reply>;

const GOOD: Reply = { score: 42, notes: ["cited LCP 5.8s"] };
const TEMPLATE: Reply = { score: 50, notes: ["template"] };

function spec(overrides: Partial<SummarySpec<Reply>> = {}): SummarySpec<Reply> {
  return {
    model: MODEL_SONNET,
    effort: "low",
    system: "You are terse.",
    prompt: "Summarise.",
    schema: Reply,
    guardrail: (v) =>
      v.notes[0] === "vague" ? { passed: false, notes: "note too vague" } : { passed: true, notes: null },
    template: () => TEMPLATE,
    ...overrides,
  };
}

const warnLines = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

let restoreEnv: () => void;
let restoreProvider: (() => void) | null = null;
beforeEach(() => {
  restoreEnv = coreModeEnv();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  restoreProvider?.();
  restoreProvider = null;
  restoreEnv();
  vi.restoreAllMocks();
});

describe("wireFormat", () => {
  it("sends the shape only: numeric/string/array bounds the Messages API rejects are stripped", () => {
    const format = wireFormat(Reply, "reply");
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("reply");
    const schema = format.schema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["score", "notes"]);
    expect(schema.properties.score).toEqual({ type: "integer" });
    expect(schema.properties.notes).toEqual({ type: "array", items: { type: "string" } });
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|minItems|minLength|\$schema/);
  });
});

describe("generateJsonSummary — structured output + OutputParseError mapping", () => {
  it("happy path: format on the wire, parsed through the schema, guardrail passes", async () => {
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec({ maxTokens: 1_500 }));
    expect(out.value).toEqual(GOOD);
    expect(out.modelUsed).toBe(MODEL_SONNET);
    expect(out.guardrailPassed).toBe(true);
    expect(p.requests).toHaveLength(1);
    const req = p.requests[0]!;
    expect(req.model).toBe(MODEL_SONNET);
    expect(req.maxTokens).toBe(1_500);
    expect(req.outputConfig?.effort).toBe("low");
    expect(req.outputConfig?.format?.type).toBe("json_schema");
    expect(req.messages[0]).toEqual({ role: "system", content: "You are terse." });
  });

  it("refused: the identical request retries once on the fallback model, then the template answers", async () => {
    const p = fakeProvider(refusalReply("cyber"));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.requests.map((r) => r.model)).toEqual([MODEL_SONNET, MODEL_REFUSAL_FALLBACK]);
    expect(p.requests[1]!.messages).toEqual(p.requests[0]!.messages); // identical request
    expect(p.requests[1]!.outputConfig).toEqual(p.requests[0]!.outputConfig);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.modelUsed).toBeNull();
    expect(out.guardrailPassed).toBe(false);
    expect(out.guardrailNotes).toMatch(/Refused by claude-opus-4-8 \(cyber\)/);
    expect(out.tokensUsed).toBe(2 * FAKE_USAGE.totalTokens); // both attempts counted
    expect(warnLines().some((l) => /refused \(cyber\) — retrying identical request on claude-opus-4-8/.test(l))).toBe(true);
  });

  it("refused on the fallback model itself: no second call", async () => {
    const p = fakeProvider(refusalReply());
    restoreProvider = p.restore;
    await generateJsonSummary(spec({ model: MODEL_OPUS }));
    expect(p.requests.map((r) => r.model)).toEqual([MODEL_OPUS]);
  });

  it("truncated: retried once with max_tokens doubled, then accepted", async () => {
    const p = fakeProvider((_req, n) => (n === 1 ? truncatedReply() : jsonReply(GOOD)));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec({ maxTokens: 1_200 }));
    expect(p.requests.map((r) => r.maxTokens)).toEqual([1_200, 2_400]);
    expect(out.value).toEqual(GOOD);
    expect(out.modelUsed).toBe(MODEL_SONNET);
    expect(out.tokensUsed).toBe(2 * FAKE_USAGE.totalTokens);
  });

  it("truncated twice: template, no third call", async () => {
    const p = fakeProvider(truncatedReply());
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.requests.map((r) => r.maxTokens)).toEqual([DEFAULT_MAX_TOKENS, 2 * DEFAULT_MAX_TOKENS]);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.guardrailNotes).toMatch(/Truncated at max_tokens 8192/);
  });

  it("invalid_json: template after exactly one call", async () => {
    const p = fakeProvider({ text: "Sure! The score is 42." });
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.requests).toHaveLength(1);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.modelUsed).toBeNull();
    expect(out.guardrailNotes).toMatch(/invalid_json/);
  });

  it("schema_mismatch (a bound the wire schema could not carry): template after exactly one call", async () => {
    const p = fakeProvider(jsonReply({ score: 150, notes: ["x"] }));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.requests).toHaveLength(1);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.guardrailNotes).toMatch(/schema_mismatch/);
  });

  it("a 429 from the provider is NOT retried here (ai-core owns retries): one call, template", async () => {
    const p = fakeProvider(
      new ProviderError("anthropic", "rate limited", { status: 429, code: "rate_limit_error", retryAfterMs: 1_000 }),
    );
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.complete).toHaveBeenCalledTimes(1);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.guardrailNotes).toMatch(/AI call failed: rate limited/);
  });

  it("guardrail protocol: fail → re-run once → persisted flagged", async () => {
    const p = fakeProvider(jsonReply({ score: 10, notes: ["vague"] }));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec());
    expect(p.requests).toHaveLength(2);
    expect(out.guardrailPassed).toBe(false);
    expect(out.modelUsed).toBe(MODEL_SONNET);
    expect(out.guardrailNotes).toBe("Guardrail failed twice: note too vague");
  });

  it("the stage signal travels as the request signal", async () => {
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    const controller = new AbortController();
    await generateJsonSummary(spec({ signal: controller.signal }));
    expect(p.requests[0]!.signal).toBe(controller.signal);
  });

  it("noRetryOnTruncation (RFL.VERIFY.3 V1): one call, template, truncatedAt = the cap", async () => {
    const p = fakeProvider(truncatedReply());
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec({ maxTokens: 8_000, noRetryOnTruncation: true }));
    expect(p.requests.map((r) => r.maxTokens)).toEqual([8_000]);
    expect(out.value).toEqual(TEMPLATE);
    expect(out.modelUsed).toBeNull();
    expect(out.truncatedAt).toBe(8_000);
    expect(out.tokensUsed).toBe(FAKE_USAGE.totalTokens);
    expect(out.guardrailNotes).toBe("Fell back to deterministic template — Truncated at max_tokens 8000");
  });

  it("timeoutMs travels per request; absent unless the caller sets it (RFL.VERIFY.3 V1)", async () => {
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    await generateJsonSummary(spec());
    await generateJsonSummary(spec({ timeoutMs: 120_000 }));
    expect(p.requests[0]!.timeoutMs).toBeUndefined();
    expect(p.requests[1]!.timeoutMs).toBe(120_000);
  });
});

describe("narration summaries (AI_SUMMARIES)", () => {
  it("default: template, the provider is never called", async () => {
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec({ model: MODEL_HAIKU, kind: "narration" }));
    expect(narrationSummaryMode()).toBe("template");
    expect(p.complete).not.toHaveBeenCalled();
    expect(out.value).toEqual(TEMPLATE);
    expect(out.modelUsed).toBeNull();
    expect(out.costCents).toBe(0);
  });

  it("AI_SUMMARIES=haiku: Haiku 4.5 with structured output and NO effort (ai-core would reject it)", async () => {
    restoreEnv();
    restoreEnv = coreModeEnv({ summaries: "haiku" });
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    const out = await generateJsonSummary(spec({ model: MODEL_HAIKU, kind: "narration", effort: "low" }));
    expect(narrationSummaryMode()).toBe("haiku");
    expect(p.requests[0]!.model).toBe(MODEL_HAIKU);
    expect(p.requests[0]!.outputConfig?.effort).toBeUndefined();
    expect(p.requests[0]!.outputConfig?.format?.type).toBe("json_schema");
    expect(out.modelUsed).toBe(MODEL_HAIKU);
  });

  it("parseAiSummaries: unset/blank/unknown → template; haiku/all → all; a list → the named agents", () => {
    expect(parseAiSummaries(undefined)).toBe("template");
    expect(parseAiSummaries("")).toBe("template");
    expect(parseAiSummaries("  ,  ")).toBe("template");
    expect(parseAiSummaries("sonnet")).toBe("template");
    expect(parseAiSummaries("haiku")).toBe("all");
    expect(parseAiSummaries("ALL")).toBe("all");
    expect(parseAiSummaries("reputation,haiku")).toBe("all");
    const one = parseAiSummaries("reputation");
    expect(one).toBeInstanceOf(Set);
    expect([...(one as Set<string>)]).toEqual(["reputation"]);
    const list = parseAiSummaries(" Reputation , seo,bogus,health ");
    expect([...(list as Set<string>)].sort()).toEqual(["health", "reputation", "seo"]);
  });

  it("AI_SUMMARIES=reputation: Haiku for reputation only, template for the other four and for an unnamed caller", async () => {
    restoreEnv();
    restoreEnv = coreModeEnv({ summaries: "reputation" });
    expect(narrationSummaryMode("reputation")).toBe("haiku");
    for (const agent of ["health", "conversion", "presence", "seo"] as const) {
      expect(narrationSummaryMode(agent)).toBe("template");
    }
    expect(narrationSummaryMode()).toBe("template");
    const p = fakeProvider(jsonReply(GOOD));
    restoreProvider = p.restore;
    const seo = await generateJsonSummary(spec({ model: MODEL_HAIKU, kind: "narration", agent: "seo" }));
    expect(seo.value).toEqual(TEMPLATE);
    expect(p.complete).not.toHaveBeenCalled();
    const rep = await generateJsonSummary(spec({ model: MODEL_HAIKU, kind: "narration", agent: "reputation" }));
    expect(rep.modelUsed).toBe(MODEL_HAIKU);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  it("AI_SUMMARIES=haiku still means all five, even for an unnamed narration caller", () => {
    restoreEnv();
    restoreEnv = coreModeEnv({ summaries: "haiku" });
    for (const agent of ["health", "conversion", "presence", "reputation", "seo"] as const) {
      expect(narrationSummaryMode(agent)).toBe("haiku");
    }
    expect(narrationSummaryMode()).toBe("haiku");
  });
});

describe("cost (finding 19 / estimateCostUsd)", () => {
  it("known models: exact microcents, cents rounded to nearest — not up", async () => {
    // Sonnet 5.5: 1000 in @ $2/M + 500 out @ $10/M = $0.007 = 0.7¢.
    expect(costMicrocentsFor(MODEL_SONNET, { ...FAKE_USAGE })).toBe(700_000);
    expect(centsFromMicrocents(700_000)).toBe(1);
    // Haiku 4.5: 100 in @ $1/M + 50 out @ $5/M = $0.00035 = 0.035¢ → 0¢ (was 1¢ under ceil).
    const haiku = costMicrocentsFor(MODEL_HAIKU, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(haiku).toBe(35_000);
    expect(centsFromMicrocents(haiku)).toBe(0);
    expect(costMicrocentsFor(MODEL_OPUS, { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })).toBe(
      500 * 1_000_000,
    );
  });

  it("an unknown model id records tokens, cost null, and logs once per id", async () => {
    const p = fakeProvider(jsonReply(GOOD, { model: "claude-mystery-9" }));
    restoreProvider = p.restore;
    const first = await generateJsonSummary(spec());
    const second = await generateJsonSummary(spec());
    expect(first.modelUsed).toBe("claude-mystery-9");
    expect(first.tokensUsed).toBe(FAKE_USAGE.totalTokens);
    expect(first.costMicrocents).toBeNull();
    expect(first.costCents).toBeNull();
    expect(second.costCents).toBeNull();
    const logged = warnLines().filter((l) => l.includes("no list price for model claude-mystery-9"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/cost_cents null/);
  });

  it("a response without usage is unknown too", () => {
    expect(costMicrocentsFor(MODEL_SONNET, undefined)).toBeNull();
  });

  it("sumMicrocents: absent counts as 0, null poisons the total", () => {
    expect(sumMicrocents([1, undefined, 2])).toBe(3);
    expect(sumMicrocents([1, null, 2])).toBeNull();
    expect(sumMicrocents([])).toBe(0);
    expect(centsFromMicrocents(null)).toBeNull();
    expect(centsFromMicrocents(499_999)).toBe(0);
    expect(centsFromMicrocents(500_000)).toBe(1);
  });

  it("callModel sums cost across the refusal fallback", async () => {
    const p = fakeProvider((req) => (req.model === MODEL_SONNET ? refusalReply() : jsonReply(GOOD)));
    restoreProvider = p.restore;
    const r = await callModel({ model: MODEL_SONNET, prompt: "p" });
    expect(r.modelUsed).toBe(MODEL_OPUS);
    expect(r.stopReason).toBe("end_turn");
    // 0.7¢ (Sonnet) + 1000@$5/M + 500@$25/M = $0.0175 = 1.75¢ (Opus) = 2.45¢
    expect(r.costMicrocents).toBe(700_000 + 1_750_000);
    expect(r.tokensUsed).toBe(2 * FAKE_USAGE.totalTokens);
  });
});

describe("generateMarkdown", () => {
  const md = (overrides: Partial<MarkdownSpec> = {}): MarkdownSpec => ({
    model: MODEL_OPUS,
    effort: "low",
    system: "s",
    prompt: "p",
    maxTokens: 4_000,
    guardrail: (text: string) => (text.includes("## Goal") ? { passed: true, notes: null } : { passed: false, notes: "no Goal" }),
    template: () => "## Goal\ntemplate",
    ...overrides,
  });

  it("strips a wrapping fence and passes the guardrail", async () => {
    const p = fakeProvider({ text: "```markdown\n## Goal\nreal\n```" });
    restoreProvider = p.restore;
    const out = await generateMarkdown(md());
    expect(out.value).toBe("## Goal\nreal");
    expect(out.modelUsed).toBe(MODEL_OPUS);
    expect(p.requests[0]!.outputConfig).toEqual({ effort: "low" });
    expect(p.requests[0]!.outputConfig?.format).toBeUndefined();
  });

  it("refusal → template; max_tokens → one retry with the cap doubled", async () => {
    const refused = fakeProvider(refusalReply("bio"));
    restoreProvider = refused.restore;
    const out = await generateMarkdown(md());
    expect(refused.requests).toHaveLength(1); // Opus is the fallback: no second model
    expect(out.value).toBe("## Goal\ntemplate");
    expect(out.guardrailNotes).toMatch(/Refused by claude-opus-4-8 \(bio\)/);
    refused.restore();

    const cut = fakeProvider((_req, n) => (n === 1 ? truncatedReply("## Go") : { text: "## Goal\nfull" }));
    restoreProvider = cut.restore;
    const out2 = await generateMarkdown(md());
    expect(cut.requests.map((r) => r.maxTokens)).toEqual([4_000, 8_000]);
    expect(out2.value).toBe("## Goal\nfull");
    expect(out2.truncatedAt).toBeUndefined();
  });

  it("noRetryOnTruncation + timeoutMs (RFL.VERIFY.3 V1): one call at the cap, then the template", async () => {
    const p = fakeProvider(truncatedReply("## Goal\ncut mid-sent"));
    restoreProvider = p.restore;
    const out = await generateMarkdown(md({ maxTokens: 8_000, noRetryOnTruncation: true, timeoutMs: 120_000 }));
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toMatchObject({ maxTokens: 8_000, timeoutMs: 120_000 });
    // The cut-off reply passes the guardrail here, yet it is never accepted.
    expect(out.value).toBe("## Goal\ntemplate");
    expect(out.modelUsed).toBeNull();
    expect(out.truncatedAt).toBe(8_000);
    expect(out.guardrailNotes).toBe("Fell back to deterministic template — Truncated at max_tokens 8000");
  });
});
