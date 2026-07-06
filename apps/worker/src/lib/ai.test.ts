import { describe, expect, it } from "vitest";
import {
  computeCostCents,
  MODEL_FABLE,
  MODEL_FABLE_FALLBACK,
  MODEL_HAIKU,
  MODEL_SONNET,
  stripJsonFences,
} from "./ai";

describe("computeCostCents", () => {
  it("prices sonnet-4-6 at 300/1500 cents per MTok, rounded up to int cents", () => {
    // Typical Design vision call: ~4K in (two screenshots + prompt), ~700 out
    // → 0.012*100 + 0.0007*1500 = 1.2 + 1.05 = 2.25¢ → 3¢ ceil.
    expect(computeCostCents(MODEL_SONNET, 4_000, 700)).toBe(3);
  });

  it("never returns fractional cents (int columns) and never rounds down", () => {
    expect(computeCostCents(MODEL_SONNET, 1, 0)).toBe(1); // 0.0003¢ → 1¢
    expect(Number.isInteger(computeCostCents(MODEL_SONNET, 123_457, 9_871))).toBe(
      true,
    );
  });

  it("zero tokens cost zero", () => {
    expect(computeCostCents(MODEL_SONNET, 0, 0)).toBe(0);
  });

  it("prices each assigned model on its own rate", () => {
    expect(computeCostCents(MODEL_HAIKU, 1_000_000, 0)).toBe(100);
    expect(computeCostCents(MODEL_SONNET, 1_000_000, 0)).toBe(300);
    expect(computeCostCents(MODEL_FABLE_FALLBACK, 1_000_000, 0)).toBe(500);
    expect(computeCostCents(MODEL_FABLE, 1_000_000, 0)).toBe(1_000);
  });

  it("matches dated model-id variants by prefix", () => {
    expect(computeCostCents("claude-haiku-4-5-20251001", 1_000_000, 0)).toBe(100);
  });

  it("bills unknown models at the highest rate (never understate)", () => {
    expect(computeCostCents("claude-mystery-9", 1_000_000, 0)).toBe(1_000);
  });
});

describe("stripJsonFences", () => {
  it("removes markdown fences around JSON", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });
});
