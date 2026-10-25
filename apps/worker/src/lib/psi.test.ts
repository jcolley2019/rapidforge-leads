import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combinePsiRuns,
  extractPsiMetrics,
  FixturePsiClient,
  PSI_RETRY_BACKOFF_MS,
  RealPsiClient,
  type PsiMetrics,
} from "./psi";
import { fallbackPsiProfile, PSI_FIXTURES } from "./psi-fixtures";

describe("extractPsiMetrics", () => {
  it("extracts categories, CWV audits, and CrUX presence", () => {
    const metrics = extractPsiMetrics({
      lighthouseResult: {
        categories: {
          performance: { score: 0.42 },
          accessibility: { score: 0.88 },
          seo: { score: 0.91 },
          "best-practices": { score: 0.75 },
        },
        audits: {
          "largest-contentful-paint": { numericValue: 5234.7 },
          "cumulative-layout-shift": { numericValue: 0.31 },
          "total-blocking-time": { numericValue: 812.2 },
        },
      },
      loadingExperience: {
        metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200 } },
      },
    });
    expect(metrics.performance).toBe(42);
    expect(metrics.accessibility).toBe(88);
    expect(metrics.seo).toBe(91);
    expect(metrics.bestPractices).toBe(75);
    expect(metrics.lcpMs).toBe(5235);
    expect(metrics.cls).toBe(0.31);
    expect(metrics.tbtMs).toBe(812);
    expect(metrics.hasCruxData).toBe(true);
  });

  it("returns nulls and no CrUX for an empty response", () => {
    const metrics = extractPsiMetrics({});
    expect(metrics.performance).toBeNull();
    expect(metrics.lcpMs).toBeNull();
    expect(metrics.hasCruxData).toBe(false);
  });
});

describe("combinePsiRuns (RFL.PSI.1)", () => {
  const runA: PsiMetrics = {
    performance: 40,
    accessibility: 80,
    seo: 90,
    bestPractices: 70,
    lcpMs: 5000,
    cls: 0.1,
    tbtMs: 800,
    hasCruxData: false,
  };
  const runB: PsiMetrics = {
    performance: 60,
    accessibility: 84,
    seo: 92,
    bestPractices: 74,
    lcpMs: 3000,
    cls: 0.3,
    tbtMs: 400,
    hasCruxData: true,
  };

  it("averages every field when both runs are present; CrUX is any-true", () => {
    expect(combinePsiRuns([runA, runB])).toEqual({
      performance: 50,
      accessibility: 82,
      seo: 91,
      bestPractices: 72,
      lcpMs: 4000,
      cls: 0.2,
      tbtMs: 600,
      hasCruxData: true,
    });
  });

  it("returns the surviving run unchanged when the other is null", () => {
    const unrounded = { ...runA, cls: 0.123456 };
    expect(combinePsiRuns([null, unrounded])).toBe(unrounded);
    expect(combinePsiRuns([runB, null])).toBe(runB);
  });

  it("returns null when every run is null or there are none", () => {
    expect(combinePsiRuns([null, null])).toBeNull();
    expect(combinePsiRuns([])).toBeNull();
  });

  it("skips per-field nulls and keeps an all-null field null", () => {
    const merged = combinePsiRuns([
      { ...runA, performance: null, cls: null, tbtMs: null },
      { ...runB, cls: null, tbtMs: null, hasCruxData: false },
    ]);
    expect(merged?.performance).toBe(60); // only runB measured it
    expect(merged?.accessibility).toBe(82);
    expect(merged?.cls).toBeNull();
    expect(merged?.tbtMs).toBeNull();
    expect(merged?.hasCruxData).toBe(false);
  });

  it("rounds scores and ms to integers and cls to 3 decimals", () => {
    const merged = combinePsiRuns([
      { ...runA, performance: 41, lcpMs: 5001, tbtMs: 801, cls: 0.1234 },
      { ...runB, performance: 46, lcpMs: 5002, tbtMs: 802, cls: 0.1239 },
    ]);
    expect(merged?.performance).toBe(44); // 43.5 → 44
    expect(merged?.lcpMs).toBe(5002); // 5001.5 → 5002
    expect(merged?.tbtMs).toBe(802); // 801.5 → 802
    expect(merged?.cls).toBe(0.124); // 0.12365 → 0.124
  });

  it("averages three runs", () => {
    const merged = combinePsiRuns([runA, runB, { ...runB, performance: 80 }]);
    expect(merged?.performance).toBe(60);
  });
});

describe("FixturePsiClient", () => {
  const client = new FixturePsiClient();

  it("serves the fixture profile for a known host", async () => {
    const mobile = await client.run(
      "https://boisedrainpros.wixsite.com/home",
      "mobile",
    );
    expect(mobile).toEqual(
      PSI_FIXTURES["boisedrainpros.wixsite.com"]!.mobile,
    );
    expect(mobile!.performance).toBeLessThan(30); // terrible tier
  });

  it("strips www. when matching hosts", async () => {
    const desktop = await client.run("https://www.rotorooter.com/x", "desktop");
    expect(desktop).toEqual(PSI_FIXTURES["www.rotorooter.com"]!.desktop);
  });

  it("falls back deterministically for unknown hosts", async () => {
    const a = await client.run("https://unknown-host.example", "mobile");
    const b = await client.run("https://unknown-host.example", "mobile");
    expect(a).toEqual(b);
    expect(a).toEqual(fallbackPsiProfile("unknown-host.example").mobile);
  });

  it("returns null for an invalid URL", async () => {
    expect(await client.run("not a url", "mobile")).toBeNull();
  });

  it("mobile is never scored better than desktop in fixtures", () => {
    for (const profile of Object.values(PSI_FIXTURES)) {
      expect(profile.mobile.performance!).toBeLessThanOrEqual(
        profile.desktop.performance!,
      );
    }
  });
});

describe("RealPsiClient retry (RFL.FIX.3i)", () => {
  const PSI_OK = {
    lighthouseResult: { categories: { performance: { score: 0.5 } } },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once on 429 then returns null", async () => {
    const fetchMock = vi.fn(async () => json({ error: "RATE_LIMITED" }, 429));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = new RealPsiClient("test-key", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(await client.run("https://example.com", "mobile")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(PSI_RETRY_BACKOFF_MS);
  });

  it("a 503 followed by a 200 returns the second run's metrics", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "UNAVAILABLE" }, 503))
      .mockResolvedValueOnce(json(PSI_OK));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = new RealPsiClient("test-key", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    const metrics = await client.run("https://example.com", "mobile");
    expect(metrics?.performance).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("a 400 is not retried", async () => {
    const fetchMock = vi.fn(async () => json({ error: "BAD_URL" }, 400));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = new RealPsiClient("test-key", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(await client.run("https://example.com", "mobile")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
