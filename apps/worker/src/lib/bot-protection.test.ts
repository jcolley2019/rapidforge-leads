/**
 * One test per BOT_CHALLENGE_SIGNATURES entry (audit finding 4), plus the
 * negatives that keep real sites — healthy or broken — out of "blocked".
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_STATUSES,
  BOT_CHALLENGE_SIGNATURES,
  detectBotProtection,
  type BotCheckInput,
} from "./bot-protection";

function page(overrides: Partial<BotCheckInput> = {}): BotCheckInput {
  return { status: 200, headers: {}, body: "", ...overrides };
}

/** A real block/challenge sample for every signature id. */
const SAMPLES: Record<string, BotCheckInput> = {
  "cloudflare-just-a-moment": page({
    status: 403,
    body: "<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title></head><body><noscript>Enable JavaScript and cookies to continue</noscript></body></html>",
  }),
  "cloudflare-attention-required": page({
    status: 403,
    body: "<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>",
  }),
  "cloudflare-challenge-header": page({
    status: 200,
    headers: { "cf-mitigated": "challenge", server: "cloudflare" },
    body: "<html><head><title>Example</title></head></html>",
  }),
  "cloudflare-challenge-script": page({
    status: 200,
    body: "<html><head><title>example.com</title><script>window._cf_chl_opt={cvId:'3',cZone:'example.com'};</script></head></html>",
  }),
  "akamai-access-denied": page({
    status: 403,
    body: "<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don't have permission to access \"http&#58;&#47;&#47;www&#46;homedepot&#46;com&#47;\" on this server.<P>\nReference&#32;&#35;18&#46;5a3c1002&#46;1720000000&#46;1f2e3d4c\n</BODY>\n</HTML>",
  }),
  "imperva-incapsula": page({
    status: 200,
    body: "<html><head><META NAME=\"robots\" CONTENT=\"noindex,nofollow\"><script src=\"/_Incapsula_Resource?SWJIYLWA=5074a744e2e3d891814e9a2dace20bd4\"></script></head><body>Request unsuccessful. Incapsula incident ID: 1234000560012345678-90123456789012345</body></html>",
  }),
  "perimeterx-press-hold": page({
    status: 403,
    body: "<html><head><title>Access to this page has been denied</title></head><body><div id=\"px-captcha\"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>",
  }),
};

describe("BOT_CHALLENGE_SIGNATURES", () => {
  it("has a sample for every signature (add one when adding a signature)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      BOT_CHALLENGE_SIGNATURES.map((s) => s.id).sort(),
    );
  });

  for (const sig of BOT_CHALLENGE_SIGNATURES) {
    it(`${sig.id} (${sig.vendor}) matches its block page and names the vendor`, () => {
      const sample = SAMPLES[sig.id]!;
      expect(sig.matches(sample)).toBe(true);
      const hit = detectBotProtection(sample);
      expect(hit).toMatchObject({ reason: sig.id, vendor: sig.vendor });
      expect(hit?.note).toBe(`${sig.vendor} bot protection (HTTP ${sample.status})`);
    });
  }
});

describe("detectBotProtection", () => {
  it.each([401, 403, 429, 503])("plain HTTP %i is blocked by status", (status) => {
    expect(BLOCKED_STATUSES.has(status)).toBe(true);
    expect(detectBotProtection(page({ status, body: "nope" }))).toMatchObject({
      reason: `http-${status}`,
      vendor: null,
    });
  });

  it.each([500, 502, 504, 404])("HTTP %i is not blocked (broken or missing, not protected)", (status) => {
    expect(detectBotProtection(page({ status, body: "<h1>Bad Gateway</h1>" }))).toBeNull();
  });

  it("does not flag a normal Cloudflare-served page with JS-detection scripts", () => {
    const normal = page({
      headers: { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-SEA" },
      body: "<html><head><title>Boise Drain Pros | Plumbing</title></head><body><h1>Call us</h1><script src=\"/cdn-cgi/challenge-platform/h/b/scripts/jsd/62ec4f065604/main.js\"></script></body></html>",
    });
    expect(detectBotProtection(normal)).toBeNull();
  });

  it("does not flag an ordinary page that merely says 'Access Denied' or 'Just a moment'", () => {
    expect(
      detectBotProtection(
        page({
          body: "<html><head><title>Member area</title></head><body>Access Denied for guests. Just a moment while we load.</body></html>",
        }),
      ),
    ).toBeNull();
  });

  it("only inspects the first 64 KB of the body", () => {
    const late = page({
      body: `<html><head><title>Home</title></head><body>${"x".repeat(70_000)}window._cf_chl_opt={}</body></html>`,
    });
    expect(detectBotProtection(late)).toBeNull();
  });
});
