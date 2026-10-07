/**
 * Test helpers for the AI seam (RFL.AI.9): a fake ai-core provider plugged in
 * through setAiProviderForTests, and the env toggles that select core mode.
 * Imported by tests only.
 */
import type { CompletionRequest, CompletionResponse } from "@rapidforge/ai-core";
import { vi } from "vitest";
import { setAiProviderForTests } from "./ai";

export type FakeReply =
  | Partial<CompletionResponse>
  | Error
  | ((request: CompletionRequest, callNumber: number) => Partial<CompletionResponse> | Error);

export const FAKE_USAGE = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 } as const;

/**
 * Install a fake provider. `reply` is merged over a plain end_turn response
 * for the requested model (or thrown when it is an Error). Returns the
 * captured requests; call `restore()` in afterEach.
 */
export function fakeProvider(reply: FakeReply = {}) {
  const requests: CompletionRequest[] = [];
  const complete = vi.fn(async (request: CompletionRequest): Promise<CompletionResponse> => {
    requests.push(request);
    const r = typeof reply === "function" ? reply(request, requests.length) : reply;
    if (r instanceof Error) throw r;
    return {
      provider: "anthropic",
      model: request.model ?? "unknown-model",
      text: "",
      finishReason: "stop",
      rawStopReason: "end_turn",
      usage: { ...FAKE_USAGE },
      ...r,
    };
  });
  setAiProviderForTests({ complete });
  return { requests, complete, restore: () => setAiProviderForTests(null) };
}

/** A reply whose text is `value` as JSON. */
export function jsonReply(
  value: unknown,
  extra: Partial<CompletionResponse> = {},
): Partial<CompletionResponse> {
  return { text: JSON.stringify(value), ...extra };
}

/** An Anthropic refusal: HTTP 200, stop_reason "refusal", with a category. */
export function refusalReply(category = "cyber"): Partial<CompletionResponse> {
  return {
    text: "",
    finishReason: "content_filter",
    rawStopReason: "refusal",
    stopDetails: { category },
  };
}

/** A reply cut off at max_tokens. */
export function truncatedReply(text = '{"score": 7'): Partial<CompletionResponse> {
  return { text, finishReason: "length", rawStopReason: "max_tokens" };
}

/**
 * Select core mode (ANTHROPIC_API_KEY present, fixtures not forced) and the
 * narration-summary mode. Returns a restore function for afterEach.
 */
export function coreModeEnv(opts: { summaries?: string | undefined } = {}): () => void {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    force: process.env.RAPIDFORGE_FORCE_FIXTURES,
    summaries: process.env.AI_SUMMARIES,
  };
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
  delete process.env.RAPIDFORGE_FORCE_FIXTURES;
  if (opts.summaries) process.env.AI_SUMMARIES = opts.summaries;
  else delete process.env.AI_SUMMARIES;
  return () => {
    for (const [key, value] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["RAPIDFORGE_FORCE_FIXTURES", saved.force],
      ["AI_SUMMARIES", saved.summaries],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
