/**
 * assertPublicUrl (RFL.SEC.1 / RFL.SSRF.1) — the worker only fetches public
 * addresses.
 *
 * A business's website_url comes from Google Places, but the worker must not
 * trust it: a row pointing at an internal address would make the worker (and
 * its headless Chrome) read a private service and hand the answer back
 * through the audit. Every site-facing request goes through here first:
 *
 *   - http / https only;
 *   - the host is resolved and EVERY address it resolves to must be public —
 *     loopback, private, link-local (incl. the cloud metadata address),
 *     CGNAT, 0.0.0.0/8, multicast/reserved and their IPv6 equivalents
 *     (::1, ::, fc00::/7, fe80::/10, v4-mapped, NAT64) are refused;
 *   - fetchPublic follows redirects by hand and checks each hop.
 *
 * A refusal is a BlockedUrlError. Callers treat it like an unreachable site:
 * the audit continues and records the reason. The message never carries the
 * resolved address (it would tell the caller what an internal name maps to).
 *
 * Known limit: the check and the connection resolve the name separately, so
 * a host that changes its DNS answer between the two (DNS rebinding) is not
 * caught here. Closing that needs a connection pinned to the checked address.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Hostname → every address it resolves to. Injectable so tests stay offline. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
  constructor(readonly reason: string) {
    super(`blocked: ${reason}`);
  }
}

/** Redirect hops fetchPublic follows before giving up. */
export const MAX_REDIRECTS = 10;

// -- address classification ------------------------------------------------------

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function isPublicIpv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && o[2] === 0) return false; // 192.0.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 literal (with optional dotted-quad tail) to 8 hextets. */
function parseIpv6(ip: string): number[] | null {
  let text = ip.split("%")[0]!; // drop a zone id
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => Number.isInteger(n)) ? out : null;
}

function isPublicIpv6(h: number[]): boolean {
  const embedded = () => [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff];
  const firstFiveZero = h.slice(0, 5).every((n) => n === 0);
  // ::/128 unspecified, ::1 loopback, and the deprecated v4-compatible ::a.b.c.d
  if (firstFiveZero && h[5] === 0) return false;
  // v4-mapped ::ffff:a.b.c.d — judged by the IPv4 address inside.
  if (firstFiveZero && h[5] === 0xffff) return isPublicIpv4(embedded());
  // NAT64 64:ff9b::/96 — reaches the embedded IPv4 address.
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) {
    return isPublicIpv4(embedded());
  }
  // 6to4 2002:a.b.c.d::/16 — reaches the embedded IPv4 address.
  if (h[0] === 0x2002) {
    return isPublicIpv4([h[1]! >> 8, h[1]! & 0xff, h[2]! >> 8, h[2]! & 0xff]);
  }
  if ((h[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((h[0]! & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((h[0]! & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

/** True only for an IP literal that is a public unicast address. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip.split("%")[0]!);
  if (family === 4) {
    const v4 = parseIpv4(ip);
    return v4 !== null && isPublicIpv4(v4);
  }
  if (family === 6) {
    const v6 = parseIpv6(ip);
    return v6 !== null && isPublicIpv6(v6);
  }
  return false;
}

// -- the check -------------------------------------------------------------------

/**
 * Resolve `url`'s host and throw BlockedUrlError unless the scheme is
 * http/https and every resolved address is public. Returns the parsed URL.
 * A DNS failure is a plain Error ("host does not resolve"): unreachable, not
 * blocked — the request could not have succeeded either way.
 */
export async function assertPublicUrl(
  url: string | URL,
  resolver: HostResolver = systemResolver,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    throw new BlockedUrlError("not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedUrlError(`scheme ${parsed.protocol.replace(/:$/, "")} is not http or https`);
  }
  // WHATWG URL already normalises numeric forms (2130706433, 0x7f.1 → 127.0.0.1).
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new BlockedUrlError("no host");

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
      throw new BlockedUrlError("host is not a public address");
    }
    try {
      addresses = await resolver(host);
    } catch {
      throw new Error("host does not resolve");
    }
    if (addresses.length === 0) throw new Error("host does not resolve");
  }
  if (!addresses.every(isPublicIp)) {
    throw new BlockedUrlError("host is not a public address");
  }
  return parsed;
}

export interface FetchPublicOptions {
  resolver?: HostResolver;
  /** fetch is injectable for tests only. */
  fetch?: typeof fetch;
}

/**
 * fetch() that only talks to public addresses: the URL is checked, redirects
 * are followed by hand (up to MAX_REDIRECTS) and every hop is checked before
 * it is requested. The returned Response's `url` is the final hop.
 */
export async function fetchPublic(
  url: string,
  init: Omit<RequestInit, "redirect"> = {},
  options: FetchPublicOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const resolver = options.resolver ?? systemResolver;
  let current = (await assertPublicUrl(url, resolver)).toString();
  for (let hop = 0; ; hop += 1) {
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new BlockedUrlError("redirect to an invalid URL");
    }
    current = (await assertPublicUrl(next, resolver)).toString();
  }
}
