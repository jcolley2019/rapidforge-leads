/**
 * buildDemo / fetchDemoStatus hit the right worker paths (RFL.DEMO.1).
 * fetch is stubbed; the offline bearer ("dev-offline") is what the worker's
 * dev mode accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDemo, fetchDemoStatus } from "./api";

const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "building", log: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("demo api", () => {
  it("buildDemo POSTs /api/businesses/:id/demo with the sub", async () => {
    await buildDemo("biz-1", "allplumbing");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/businesses\/biz-1\/demo$/);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ sub: "allplumbing" }));
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it("buildDemo without a sub sends an empty body (the CLI picks the default)", async () => {
    await buildDemo("biz-1");
    expect(calls[0]!.init?.body).toBe("{}");
  });

  it("fetchDemoStatus GETs /api/businesses/:id/demo", async () => {
    const res = await fetchDemoStatus("biz 2");
    expect(calls[0]!.url).toMatch(/\/api\/businesses\/biz%202\/demo$/);
    expect(calls[0]!.init?.method).toBeUndefined();
    expect((res as unknown as { status: string }).status).toBe("building");
  });

  it("surfaces the worker's error message (409 while building)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "A demo build is already running for this business" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(buildDemo("biz-1")).rejects.toThrow("A demo build is already running for this business");
  });
});
