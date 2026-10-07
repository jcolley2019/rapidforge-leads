import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractPsiMetrics,
  FixturePsiClient,
  PSI_RETRY_BACKOFF_MS,
  RealPsiClient,
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
