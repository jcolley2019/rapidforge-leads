/**
 * Coaching-tip dismissals (RFL.HELP.4): per-user localStorage, guarded so
 * corrupt or unavailable storage reads as "nothing dismissed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIP_IDS,
  coachingKey,
  dismiss,
  isDismissed,
  resetAll,
} from "./coaching";

/** Minimal in-memory Storage — the web tests run without a DOM. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coaching tips storage", () => {
  it("keys storage per user", () => {
    expect(coachingKey("user-1")).toBe("rapidforge-coaching:user-1");
  });

  it("dismiss → isDismissed true, for that tip only", () => {
    expect(isDismissed("u1", "dashboard")).toBe(false);
    dismiss("u1", "dashboard");
    expect(isDismissed("u1", "dashboard")).toBe(true);
    expect(isDismissed("u1", "leads")).toBe(false);
    expect(JSON.parse(storage.getItem(coachingKey("u1")) ?? "")).toEqual([
      "dashboard",
    ]);
  });

  it("dismissing twice stores the id once", () => {
    dismiss("u1", "drawer");
    dismiss("u1", "drawer");
    expect(JSON.parse(storage.getItem(coachingKey("u1")) ?? "")).toEqual([
      "drawer",
    ]);
  });

  it("resetAll clears every dismissal for that user", () => {
    for (const id of TIP_IDS) dismiss("u1", id);
    expect(TIP_IDS.every((id) => isDismissed("u1", id))).toBe(true);
    resetAll("u1");
    expect(TIP_IDS.some((id) => isDismissed("u1", id))).toBe(false);
    expect(storage.getItem(coachingKey("u1"))).toBeNull();
  });

  it("user A's dismissal doesn't hide user B's tip, and B's reset keeps A's", () => {
    dismiss("user-a", "pipeline");
    expect(isDismissed("user-a", "pipeline")).toBe(true);
    expect(isDismissed("user-b", "pipeline")).toBe(false);
    resetAll("user-b");
    expect(isDismissed("user-a", "pipeline")).toBe(true);
  });

  it("corrupt JSON is treated as nothing dismissed, and the next dismiss repairs it", () => {
    storage.setItem(coachingKey("u1"), "{not json");
    expect(isDismissed("u1", "dashboard")).toBe(false);
    dismiss("u1", "dashboard");
    expect(JSON.parse(storage.getItem(coachingKey("u1")) ?? "")).toEqual([
      "dashboard",
    ]);
  });

  it("valid JSON of the wrong shape is treated as nothing dismissed", () => {
    storage.setItem(coachingKey("u1"), JSON.stringify({ dashboard: true }));
    expect(isDismissed("u1", "dashboard")).toBe(false);
    storage.setItem(coachingKey("u1"), JSON.stringify(["leads", 7, null]));
    expect(isDismissed("u1", "leads")).toBe(true);
  });

  it("storage that throws never throws to the caller", () => {
    const fail = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", {
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    });
    expect(isDismissed("u1", "dashboard")).toBe(false);
    expect(() => dismiss("u1", "dashboard")).not.toThrow();
    expect(() => resetAll("u1")).not.toThrow();
  });
});
