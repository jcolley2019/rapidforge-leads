import { describe, expect, it } from "vitest";
import type { DemoStatusResponse } from "./api";
import { defaultDemoSub, demoView } from "./demo";

describe("defaultDemoSub", () => {
  it("takes the first DNS-safe word of the name, lowercased", () => {
    expect(defaultDemoSub("All Plumbing & Sewer")).toBe("allplumbing");
    expect(defaultDemoSub("Boise Drain Pros")).toBe("boisedrainpros");
    expect(defaultDemoSub("Bob's Plumbing, LLC")).toBe("bobsplumbing");
    expect(defaultDemoSub("Río Grande Heating")).toBe("riograndeheating");
  });

  it("is empty when nothing usable is left", () => {
    expect(defaultDemoSub("&&&")).toBe("");
    expect(defaultDemoSub("")).toBe("");
  });
});

const base: DemoStatusResponse = {
  demo_status: null,
  demo_url: null,
  demo_preview_url: null,
  demo_sub: null,
  demo_built_at: null,
  demo_error: null,
  log: [],
  alias_ok: null,
};

describe("demoView", () => {
  it("none without a status row", () => {
    expect(demoView(null)).toEqual({ kind: "none" });
    expect(demoView(base)).toEqual({ kind: "none" });
  });

  it("building prefers the longer of the live and polled logs", () => {
    const polled = { ...base, demo_status: "building" as const, log: ["a", "b", "c"] };
    expect(demoView(polled, ["a"])).toEqual({ kind: "building", log: ["a", "b", "c"] });
    expect(demoView(polled, ["a", "b", "c", "d"])).toEqual({ kind: "building", log: ["a", "b", "c", "d"] });
  });

  it("ready carries the links, built-at and the DNS note flag", () => {
    expect(
      demoView({
        ...base,
        demo_status: "ready",
        demo_url: "https://allplumbing.demos.rapidforge.ai",
        demo_preview_url: "https://x.vercel.app",
        demo_built_at: "2026-10-07T18:00:00.000Z",
        alias_ok: false,
      }),
    ).toEqual({
      kind: "ready",
      url: "https://allplumbing.demos.rapidforge.ai",
      previewUrl: "https://x.vercel.app",
      builtAt: "2026-10-07T18:00:00.000Z",
      dnsPending: true,
    });
  });

  it("failed carries demo_error", () => {
    expect(demoView({ ...base, demo_status: "failed", demo_error: "deploy: boom" })).toEqual({
      kind: "failed",
      error: "deploy: boom",
    });
  });
});
