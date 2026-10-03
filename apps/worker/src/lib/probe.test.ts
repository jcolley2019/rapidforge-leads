/**
 * RealWebProbe tri-state (audit finding 4) with a mocked fetch:
 * blocked → "unknown", genuine server failure / unreachable → "no",
 * the real site → "yes". Plus the browser-like request headers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_USER_AGENT,
  LEGACY_AUDIT_USER_AGENT,
} from "./browser-headers";
import { RealWebProbe } from "./probe";

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

const URL_UNDER_TEST = "https://example-plumbing.com/";

describe("RealWebProbe", () => {
  afterEach(() => {
    delete process.env.RAPIDFORGE_LEGACY_UA;
  });

  it("403 with a Cloudflare challenge body → unknown (cloudflare-just-a-moment)", async () => {
    const fetchMock = respond(
      403,
      "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>",
      { server: "cloudflare" },
    );
    const result = await new RealWebProbe({ fetch: fetchMock }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({
      alive: "unknown",
      httpStatus: 403,
      blockedBy: "cloudflare-just-a-moment",
      note: "Cloudflare bot protection (HTTP 403)",
    });
  });

  it("plain 503 → unknown (http-503), not dead", async () => {
    const result = await new RealWebProbe({
      fetch: respond(503, "Service Unavailable"),
    }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({
      alive: "unknown",
      httpStatus: 503,
      blockedBy: "http-503",
    });
  });

  it("429 → unknown (http-429)", async () => {
    const result = await new RealWebProbe({
      fetch: respond(429, "Too Many Requests"),
    }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({ alive: "unknown", blockedBy: "http-429" });
  });

  it("200 with a challenge body → unknown", async () => {
    const result = await new RealWebProbe({
      fetch: respond(
        200,
        "<html><body><div id=\"px-captcha\"></div>Press &amp; Hold to confirm you are a human</body></html>",
      ),
    }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({
      alive: "unknown",
      httpStatus: 200,
      blockedBy: "perimeterx-press-hold",
    });
  });

  it("502 → no (genuinely broken)", async () => {
    const result = await new RealWebProbe({
      fetch: respond(502, "<h1>502 Bad Gateway</h1>"),
    }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({
      alive: "no",
      httpStatus: 502,
      blockedBy: null,
      note: "Server error 502",
    });
  });

  it("timeout → no (unreachable)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await new RealWebProbe({ fetch: fetchMock }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({ alive: "no", httpStatus: null, blockedBy: null });
    expect(result.note).toMatch(/^Unreachable: .*timeout/);
  });

  it("a body that errors mid-read keeps the status verdict (200 → yes, not dead)", async () => {
    const fetchMock = vi.fn(async () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("<html><head><title>Home"));
          } else {
            controller.error(new Error("socket hang up"));
          }
        },
      });
      return new Response(body, { status: 200 });
    });
    const result = await new RealWebProbe({ fetch: fetchMock }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({ alive: "yes", httpStatus: 200, blockedBy: null });
  });

  it("200 real page → yes, via one GET with browser headers", async () => {
    const fetchMock = respond(200, "<html><head><title>Example Plumbing</title></head></html>");
    const result = await new RealWebProbe({ fetch: fetchMock }).probe(URL_UNDER_TEST);
    expect(result).toMatchObject({ alive: "yes", httpStatus: 200, blockedBy: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(BROWSER_USER_AGENT);
    expect(headers["User-Agent"]).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    expect(headers.Accept).toMatch(/^text\/html/);
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("RAPIDFORGE_LEGACY_UA=true restores the old audit UA for debugging", async () => {
    process.env.RAPIDFORGE_LEGACY_UA = "true";
    const fetchMock = respond(200, "<html></html>");
    await new RealWebProbe({ fetch: fetchMock }).probe(URL_UNDER_TEST);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
      LEGACY_AUDIT_USER_AGENT,
    );
  });
});
