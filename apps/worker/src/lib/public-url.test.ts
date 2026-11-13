/**
 * assertPublicUrl / fetchPublic / guardPageRequests (RFL.SEC.1, RFL.SSRF.1).
 * Hermetic: DNS and fetch are fakes; no socket is opened.
 */
import { describe, expect, it, vi } from "vitest";
import { guardPageRequests, type GuardablePage, type GuardableRequest } from "./browser";
import { RealWebProbe } from "./probe";
import {
  assertPublicUrl,
  BlockedUrlError,
  fetchPublic,
  isPublicIp,
  MAX_REDIRECTS,
  type HostResolver,
} from "./public-url";
import { RealSiteFetcher } from "./site";

const PUBLIC_IP = "93.184.216.34";

/** Fake DNS: a fixed table; anything else fails like ENOTFOUND. */
function dns(table: Record<string, string[]>): HostResolver {
  return async (host) => {
    const hit = table[host];
    if (!hit) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return hit;
  };
}

const neverResolve: HostResolver = async () => {
  throw new Error("the resolver must not be called for an IP literal");
};

describe("isPublicIp", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback (any 127/8)", "127.255.255.254"],
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12 (low edge)", "172.16.0.1"],
    ["private 172.16/12 (high edge)", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.10"],
    ["link-local 169.254/16", "169.254.10.10"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT 100.64/10 (low edge)", "100.64.0.1"],
    ["CGNAT 100.64/10 (high edge)", "100.127.255.255"],
    ["0.0.0.0", "0.0.0.0"],
    ["0.0.0.0/8", "0.1.2.3"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique local fc00::/7", "fc00::1"],
    ["IPv6 unique local fd00::/8", "fd12:3456:789a::1"],
    ["IPv6 link-local fe80::/10", "fe80::1"],
    ["IPv6 link-local with zone", "fe80::1%eth0"],
    ["IPv6 multicast", "ff02::1"],
    ["v4-mapped loopback", "::ffff:127.0.0.1"],
    ["v4-mapped private (hex form)", "::ffff:a00:5"],
    ["v4-mapped metadata", "::ffff:169.254.169.254"],
    ["NAT64 to private", "64:ff9b::10.0.0.1"],
    ["6to4 to private", "2002:c0a8:0101::1"],
  ])("blocks %s (%s)", (_label, ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    ["a public IPv4", PUBLIC_IP],
    ["just outside 172.16/12", "172.32.0.1"],
    ["just outside 100.64/10", "100.128.0.1"],
    ["just outside 169.254/16", "169.255.0.1"],
    ["a public IPv6", "2606:4700:4700::1111"],
    ["v4-mapped public", "::ffff:93.184.216.34"],
  ])("allows %s (%s)", (_label, ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it("is false for anything that is not an IP literal", () => {
    expect(isPublicIp("example.com")).toBe(false);
    expect(isPublicIp("")).toBe(false);
    expect(isPublicIp("1.2.3")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("passes a host that resolves to a public address", async () => {
    const url = await assertPublicUrl("https://example.com/path?q=1", dns({ "example.com": [PUBLIC_IP] }));
    expect(url.hostname).toBe("example.com");
  });

  it("passes a public IP literal without a lookup", async () => {
    await expect(assertPublicUrl(`http://${PUBLIC_IP}/`, neverResolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://[2606:4700:4700::1111]/", neverResolve)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:8788/health",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    // Numeric spellings the URL parser folds into 127.0.0.1.
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://017700000001/",
    "http://127.1/",
  ])("blocks the literal %s", async (url) => {
    await expect(assertPublicUrl(url, neverResolve)).rejects.toThrow(BlockedUrlError);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.1.2.3"],
    ["private", "172.20.0.9"],
    ["private", "192.168.0.20"],
    ["metadata", "169.254.169.254"],
    ["CGNAT", "100.100.100.100"],
    ["zero", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique local", "fd00::5"],
    ["IPv6 link-local", "fe80::abcd"],
    ["v4-mapped", "::ffff:10.0.0.1"],
  ])("blocks a name that resolves to a %s address (%s)", async (_label, ip) => {
    const err = await assertPublicUrl("https://internal.example/", dns({ "internal.example": [ip] })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BlockedUrlError);
    // The reason never tells the caller what the name resolved to.
    expect((err as Error).message).toBe("blocked: host is not a public address");
    expect((err as Error).message).not.toContain(ip);
  });

  it("blocks when ANY resolved address is private (mixed A records)", async () => {
    await expect(
      assertPublicUrl("https://mixed.example/", dns({ "mixed.example": [PUBLIC_IP, "10.0.0.1"] })),
    ).rejects.toThrow(BlockedUrlError);
  });

  it("blocks localhost names without a lookup", async () => {
    for (const url of ["http://localhost/", "http://LOCALHOST:3000/", "http://api.localhost/", "http://localhost./"]) {
      await expect(assertPublicUrl(url, neverResolve)).rejects.toThrow(BlockedUrlError);
    }
  });

  it("blocks every scheme but http and https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "data:text/html,x", "javascript:alert(1)"]) {
      await expect(assertPublicUrl(url, neverResolve)).rejects.toThrow(/is not http or https/);
    }
    await expect(assertPublicUrl("not a url", neverResolve)).rejects.toThrow(/not a valid URL/);
  });

  it("a name that does not resolve is unreachable, not 'blocked'", async () => {
    const err = await assertPublicUrl("https://nope.example/", dns({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlockedUrlError);
    expect((err as Error).message).toBe("host does not resolve");
  });
});

/** A fetch fake answering from a URL → Response table, recording each call. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const res = route();
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  return { impl, calls };
}

const redirectTo = (location: string, status = 302) => () =>
  new Response(null, { status, headers: { location } });
const page = (body = "<html><title>ok</title></html>") => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });

const resolver = dns({
  "public.example": [PUBLIC_IP],
  "www.public.example": [PUBLIC_IP],
  "rebound.example": ["192.168.1.50"],
});

describe("fetchPublic", () => {
  it("fetches a public URL with redirect: manual", async () => {
    const { impl, calls } = fakeFetch({ "https://public.example/": page() });
    const res = await fetchPublic("https://public.example/", {}, { fetch: impl, resolver });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "https://public.example/", redirect: "manual" }]);
  });

  it("follows public redirects (absolute and relative) and reports the final URL", async () => {
    const { impl, calls } = fakeFetch({
      "http://public.example/": redirectTo("https://www.public.example/", 301),
      "https://www.public.example/": redirectTo("/home", 302),
      "https://www.public.example/home": page(),
    });
    const res = await fetchPublic("http://public.example/", {}, { fetch: impl, resolver });
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://www.public.example/home");
    expect(calls.map((c) => c.url)).toEqual([
      "http://public.example/",
      "https://www.public.example/",
      "https://www.public.example/home",
    ]);
  });

  it("never requests a private first hop", async () => {
    const { impl, calls } = fakeFetch({});
    await expect(fetchPublic("http://169.254.169.254/latest/meta-data/", {}, { fetch: impl, resolver })).rejects.toThrow(
      BlockedUrlError,
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["a private IP", "http://10.0.0.5/secret"],
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8788/health"],
    ["a name that resolves privately", "https://rebound.example/"],
    ["an IPv6 loopback", "http://[::1]/"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("blocks a redirect from a public site to %s", async (_label, target) => {
    const { impl, calls } = fakeFetch({ "https://public.example/": redirectTo(target) });
    await expect(fetchPublic("https://public.example/", {}, { fetch: impl, resolver })).rejects.toThrow(BlockedUrlError);
    // The private hop was never requested.
    expect(calls.map((c) => c.url)).toEqual(["https://public.example/"]);
  });

  it("blocks a private hop at the end of a longer public chain", async () => {
    const { impl, calls } = fakeFetch({
      "https://public.example/": redirectTo("https://www.public.example/a"),
      "https://www.public.example/a": redirectTo("http://192.168.0.1/"),
    });
    await expect(fetchPublic("https://public.example/", {}, { fetch: impl, resolver })).rejects.toThrow(BlockedUrlError);
    expect(calls).toHaveLength(2);
  });

  it("gives up on a redirect loop", async () => {
    const { impl, calls } = fakeFetch({ "https://public.example/": redirectTo("https://public.example/") });
    await expect(fetchPublic("https://public.example/", {}, { fetch: impl, resolver })).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("a 3xx without a Location header is returned as-is", async () => {
    const { impl } = fakeFetch({ "https://public.example/": () => new Response(null, { status: 304 }) });
    expect((await fetchPublic("https://public.example/", {}, { fetch: impl, resolver })).status).toBe(304);
  });
});

describe("RealWebProbe + RealSiteFetcher behind the guard", () => {
  it("probe: a private target reads as unreachable with the reason, and is never requested", async () => {
    const { impl, calls } = fakeFetch({});
    const result = await new RealWebProbe({ fetch: impl, resolver }).probe("http://10.0.0.5/");
    expect(result).toMatchObject({
      alive: "no",
      httpStatus: null,
      sslValid: false,
      note: "Unreachable: blocked: host is not a public address",
      blockedBy: null,
    });
    expect(calls).toEqual([]);
  });

  it("probe: a public site that redirects to a private address reads as unreachable", async () => {
    const { impl, calls } = fakeFetch({ "https://public.example/": redirectTo("http://169.254.169.254/") });
    const result = await new RealWebProbe({ fetch: impl, resolver }).probe("https://public.example/");
    expect(result.alive).toBe("no");
    expect(result.note).toBe("Unreachable: blocked: host is not a public address");
    expect(calls).toHaveLength(1);
  });

  it("probe: a public site still answers", async () => {
    const { impl } = fakeFetch({ "https://public.example/": page() });
    const result = await new RealWebProbe({ fetch: impl, resolver }).probe("https://public.example/");
    expect(result).toMatchObject({ alive: "yes", httpStatus: 200, sslValid: true });
  });

  it("site: fetchHomepage returns null for a private target or a private redirect, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { impl, calls } = fakeFetch({ "https://public.example/": redirectTo("http://127.0.0.1/") });
    const site = new RealSiteFetcher({ fetch: impl, resolver });
    expect(await site.fetchHomepage("http://192.168.1.1/")).toBeNull();
    expect(await site.fetchHomepage("https://public.example/")).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["https://public.example/"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("blocked: host is not a public address"));
    warn.mockRestore();
  });

  it("site: fetchHomepage follows a public redirect and reports the final URL", async () => {
    const { impl } = fakeFetch({
      "http://public.example/": redirectTo("https://www.public.example/"),
      "https://www.public.example/": page("<html>hello</html>"),
    });
    const got = await new RealSiteFetcher({ fetch: impl, resolver }).fetchHomepage("http://public.example/");
    expect(got).toMatchObject({
      html: "<html>hello</html>",
      httpStatus: 200,
      finalUrl: "https://www.public.example/",
      sslValid: true,
    });
  });

  it("site: checkPath is unknown (null) for a private target, true for a public one", async () => {
    const { impl } = fakeFetch({ "https://public.example/robots.txt": page("User-agent: *") });
    const site = new RealSiteFetcher({ fetch: impl, resolver });
    expect(await site.checkPath("http://10.0.0.5/", "/robots.txt")).toBeNull();
    expect(await site.checkPath("https://public.example/", "/robots.txt")).toBe(true);
  });
});

describe("guardPageRequests (Chrome)", () => {
  const MAIN_FRAME = { name: "main" };
  const CHILD_FRAME = { name: "child" };

  function fakePage() {
    let handler: ((request: GuardableRequest) => void) | null = null;
    const interception: boolean[] = [];
    const fake: GuardablePage = {
      setRequestInterception: async (value) => {
        interception.push(value);
      },
      on: (_event, h) => {
        handler = h;
      },
      mainFrame: () => MAIN_FRAME,
    };
    /** Send one request through the guard; resolves with what it did. */
    const send = (url: string, opts: { navigation?: boolean; frame?: unknown } = {}) =>
      new Promise<"continue" | "abort">((resolve) => {
        handler!({
          url: () => url,
          isNavigationRequest: () => opts.navigation ?? false,
          frame: () => opts.frame ?? MAIN_FRAME,
          continue: async () => resolve("continue"),
          abort: async () => resolve("abort"),
        });
      });
    return { fake, send, interception };
  }

  it("turns interception on and lets a public main-frame navigation through", async () => {
    const { fake, send, interception } = fakePage();
    const guard = await guardPageRequests(fake, resolver);
    expect(interception).toEqual([true]);
    expect(await send("https://public.example/", { navigation: true })).toBe("continue");
    expect(guard.mainFrameBlocked()).toBeNull();
  });

  it("aborts a private main-frame navigation and remembers why", async () => {
    const { fake, send } = fakePage();
    const guard = await guardPageRequests(fake, resolver);
    expect(await send("http://10.0.0.5/", { navigation: true })).toBe("abort");
    expect(guard.mainFrameBlocked()).toBeInstanceOf(BlockedUrlError);
    expect(guard.mainFrameBlocked()?.message).toBe("blocked: host is not a public address");
  });

  it("aborts a redirect hop from a public page to a private address", async () => {
    const { fake, send } = fakePage();
    const guard = await guardPageRequests(fake, resolver);
    expect(await send("https://public.example/", { navigation: true })).toBe("continue");
    // Puppeteer raises a fresh request event for each redirect hop.
    expect(await send("http://169.254.169.254/latest/meta-data/", { navigation: true })).toBe("abort");
    expect(guard.mainFrameBlocked()).toBeInstanceOf(BlockedUrlError);
  });

  it("aborts private subresources and iframes without failing the page", async () => {
    const { fake, send } = fakePage();
    const guard = await guardPageRequests(fake, resolver);
    expect(await send("http://192.168.1.1/logo.png")).toBe("abort");
    expect(await send("https://rebound.example/frame", { navigation: true, frame: CHILD_FRAME })).toBe("abort");
    expect(await send("https://www.public.example/app.js")).toBe("continue");
    expect(guard.mainFrameBlocked()).toBeNull();
  });

  it("aborts a host that does not resolve, passes data: and about: URLs", async () => {
    const { fake, send } = fakePage();
    const guard = await guardPageRequests(fake, resolver);
    expect(await send("https://nope.example/x.js")).toBe("abort");
    expect(await send("data:image/png;base64,AAAA")).toBe("continue");
    expect(await send("about:blank", { navigation: true })).toBe("continue");
    expect(guard.mainFrameBlocked()).toBeNull();
  });

  it("resolves each host once per page", async () => {
    const lookups: string[] = [];
    const counting: HostResolver = async (host) => {
      lookups.push(host);
      return [PUBLIC_IP];
    };
    const { fake, send } = fakePage();
    await guardPageRequests(fake, counting);
    await send("https://cdn.example/a.js");
    await send("https://cdn.example/b.css");
    await send("https://cdn.example/c.png");
    expect(lookups).toEqual(["cdn.example"]);
  });
});
