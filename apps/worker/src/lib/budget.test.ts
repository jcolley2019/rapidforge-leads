import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageAbortedError, StageTimeoutError, withBudget } from "./budget";

describe("withBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with StageTimeoutError when the budget elapses, aborting the run signal", async () => {
    let seen: AbortSignal | null = null;
    const p = withBudget("stage", 1_000, (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    const assertion = expect(p).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(seen!.aborted).toBe(true);
  });

  it("a synchronous throw from run rejects with that error and clears the timer", async () => {
    const outer = new AbortController();
    const removeSpy = vi.spyOn(outer.signal, "removeEventListener");
    const p = withBudget(
      "launch",
      20_000,
      () => {
        throw new Error("spawn EACCES");
      },
      outer.signal,
    );
    await expect(p).rejects.toThrow("spawn EACCES");
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("an outer abort rejects with StageAbortedError", async () => {
    const outer = new AbortController();
    const p = withBudget("stage", 60_000, () => new Promise<never>(() => undefined), outer.signal);
    outer.abort();
    await expect(p).rejects.toBeInstanceOf(StageAbortedError);
  });
});
