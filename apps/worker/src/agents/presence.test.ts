import { describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import { SITE_FIXTURES } from "../lib/site-fixtures";
import {
  buildTemplatePresenceSummary,
  compareNap,
  findSocialLinks,
  normalizeAddress,
  normalizePhoneDigits,
} from "./presence";
import { makePresenceSummaryGuardrail } from "./guardrails/presence-summary";

function business(overrides: Partial<Business>): Business {
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    workspace_id: "00000000-0000-4000-8000-00000000bbbb",
    google_place_id: "fx-test",
    name: "Test Business",
    phone: "(208) 555-0101",
    website_url: "https://example.com",
    address: "1120 N Main St, Meridian, ID 83642",
    lat: null,
    lng: null,
    google_rating: 4.5,
    review_count: 10,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
    ...overrides,
  };
}

describe("normalizePhoneDigits", () => {
  it.each([
    ["(208) 555-0101", "2085550101"],
    ["+12085550101", "2085550101"],
    ["208.555.0101", "2085550101"],
    ["208 555 0101", "2085550101"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizePhoneDigits(raw)).toBe(expected);
  });

  it("rejects non-US-shaped numbers", () => {
    expect(normalizePhoneDigits("555-0101")).toBeNull();
    expect(normalizePhoneDigits("+44 20 7946 0958")).toBeNull();
    expect(normalizePhoneDigits("")).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("collapses abbreviations, case, and punctuation to one form", () => {
    expect(normalizeAddress("1120 North Main Street")).toBe(
      normalizeAddress("1120 N Main St."),
    );
    expect(normalizeAddress("7800 W. Fairview Ave, Boise")).toBe(
      normalizeAddress("7800 West Fairview Avenue Boise"),
    );
  });
});

describe("compareNap", () => {
  it("matches a consistent site (snakeriver)", () => {
    const nap = compareNap(
      business({}),
      SITE_FIXTURES["snakeriverplumbing.com"]!.html,
    );
    expect(nap.nap_phone_match).toBe(true);
    expect(nap.nap_address_match).toBe(true);
    expect(nap.nap_consistent).toBe(true);
  });

  it("flags a mismatch when the site shows a different number and old address", () => {
    const nap = compareNap(
      business({
        phone: "(208) 555-0102",
        address: "7800 W Fairview Ave, Boise, ID 83704",
      }),
      SITE_FIXTURES["boisedrainpros.wixsite.com"]!.html,
    );
    expect(nap.nap_phone_match).toBe(false); // site shows (208) 555-9987
    expect(nap.nap_address_match).toBe(false); // site shows Overland Rd
    expect(nap.nap_consistent).toBe(false);
  });

  it("flags the vistaheatcool wrong-number case even when the address matches", () => {
    const nap = compareNap(
      business({
        phone: "(208) 555-0122",
        address: "2109 S Vista Ave, Boise, ID 83705",
      }),
      SITE_FIXTURES["vistaheatcool.com"]!.html,
    );
    expect(nap.nap_phone_match).toBe(false);
    expect(nap.nap_address_match).toBe(true);
    expect(nap.nap_consistent).toBe(false);
  });

  it("returns unknown (null) instead of inventing when a side is missing", () => {
    // Business has no phone; site has no phone either (gcgaragedoor).
    const nap = compareNap(
      business({ phone: null, address: "3663 W Adams St, Garden City, ID" }),
      SITE_FIXTURES["gcgaragedoor.com"]!.html,
    );
    expect(nap.nap_phone_match).toBeNull();
    expect(nap.nap_address_match).toBe(true);
    expect(nap.nap_consistent).toBeNull(); // partial evidence — not claimed
  });
});

describe("findSocialLinks", () => {
  it("finds and dedupes social profiles", () => {
    const links = findSocialLinks(
      SITE_FIXTURES["snakeriverplumbing.com"]!.html,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("facebook.com");
  });
});

describe("template presence summary + guardrail", () => {
  it("consistent verdict carries compared values and passes", () => {
    const biz = business({});
    const nap = compareNap(biz, SITE_FIXTURES["snakeriverplumbing.com"]!.html);
    const summary = buildTemplatePresenceSummary(biz, nap, []);
    expect(summary.nap_assessment).toBe("consistent");
    expect(
      makePresenceSummaryGuardrail({ napConsistent: nap.nap_consistent })(
        summary,
      ).passed,
    ).toBe(true);
  });

  it("guardrail rejects a 'consistent' verdict that contradicts deterministic mismatch", () => {
    const biz = business({});
    const nap = compareNap(biz, SITE_FIXTURES["snakeriverplumbing.com"]!.html);
    const summary = buildTemplatePresenceSummary(biz, nap, []);
    expect(
      makePresenceSummaryGuardrail({ napConsistent: false })(summary).passed,
    ).toBe(false);
  });
});
