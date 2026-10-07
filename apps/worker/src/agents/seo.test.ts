import { describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import { cityFromPlacesAddress } from "../lib/address";
import type { FetchedSite } from "../lib/site";
import { SITE_FIXTURES } from "../lib/site-fixtures";
import {
  makeSeoSummaryGuardrail,
  seoChecksInvariant,
} from "./guardrails/seo-summary";
import {
  buildTemplateSeoSummary,
  categoryPattern,
  extractH1s,
  extractMetaDescription,
  extractSchemaTypes,
  extractTitle,
  runSeo,
  runSeoChecks,
} from "./seo";

function siteFor(host: string): FetchedSite {
  const fixture = SITE_FIXTURES[host]!;
  return {
    html: fixture.html,
    httpStatus: fixture.httpStatus,
    responseMs: fixture.responseMs,
    finalUrl: `https://${host}/`,
    sslValid: true,
    headers: fixture.headers,
  };
}

function businessWith(address: string | null, category: string | null): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-test",
    name: "Test Business",
    phone: null,
    website_url: "https://example.com/",
    address,
    lat: null,
    lng: null,
    google_rating: null,
    review_count: null,
    category,
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    last_refreshed_at: null,
    first_seen_at: "2026-07-05T00:00:00Z",
  } as Business;
}

describe("deterministic extraction (PRD 6.10)", () => {
  const good = SITE_FIXTURES["snakeriverplumbing.com"]!.html;
  const wix = SITE_FIXTURES["boisedrainpros.wixsite.com"]!.html;

  it("extracts the title", () => {
    expect(extractTitle(good)).toEqual({
      found: true,
      value: "Snake River Plumbing Co | Meridian ID Plumber",
    });
  });

  it("reports a missing meta description as found=false with null value", () => {
    expect(extractMetaDescription(wix)).toEqual({ found: false, value: null });
  });

  it("extracts meta description in either attribute order", () => {
    expect(
      extractMetaDescription(
        `<meta name="description" content="Boise plumbing pros.">`,
      ),
    ).toEqual({ found: true, value: "Boise plumbing pros." });
    expect(
      extractMetaDescription(
        `<meta content="Boise plumbing pros." name="description">`,
      ),
    ).toEqual({ found: true, value: "Boise plumbing pros." });
  });

  it("extracts H1 text with entities decoded", () => {
    expect(extractH1s(good)).toEqual(["Meridian's Trusted Plumbers Since 2004"]);
    expect(extractH1s(wix)).toEqual(["Welcome to our website"]);
  });

  it("extracts schema.org types from ld+json", () => {
    expect(extractSchemaTypes(good)).toContain("LocalBusiness");
    expect(extractSchemaTypes(wix)).toEqual([]);
  });

  it("parses the city from both Places address shapes", () => {
    expect(cityFromPlacesAddress("1120 N Main St, Meridian, ID 83642")).toBe(
      "Meridian",
    );
    expect(cityFromPlacesAddress("8990 W Overland Rd, Boise ID")).toBe("Boise");
    expect(cityFromPlacesAddress(null)).toBeNull();
  });

  it("city from a 4-part Places (New) address", () => {
    // Places (New) formattedAddress ends in the country (RFL.AUDIT.2 Part 3).
    expect(cityFromPlacesAddress("11567 Lake Shore Dr, Nampa, ID 83686, USA")).toBe("Nampa");
    expect(cityFromPlacesAddress("1519 W Florida Ave, Nampa, ID 83686, USA")).toBe("Nampa");
    expect(cityFromPlacesAddress("123 Main St, Ste 4, Boise, ID 83702-1234, USA")).toBe("Boise");
    expect(cityFromPlacesAddress("Nampa, ID 83686, USA")).toBe("Nampa");
    expect(cityFromPlacesAddress("ID 83686, USA")).toBeNull();
    // Landers: title + meta name Nampa; the old parser read "ID 83686".
    const checks = runSeoChecks(
      `<title>Nampa Handyman &amp; Remodeling Contractor, Landers Home Services</title>
       <meta name="description" content="Landers is a top rated Nampa Handyman &amp; Remodeling Service.">
       <h1>Hire Home repair experts you can trust</h1>`,
      { address: "1519 W Florida Ave, Nampa, ID 83686, USA", category: "general_contractor" },
      null,
      null,
    );
    expect(checks.city).toBe("Nampa");
    expect(checks.title_has_city).toBe(true);
    expect(checks.meta_has_city).toBe(true);
    expect(checks.h1_has_city).toBe(false);
  });

  it("category plumber matches Plumbing; general_contractor matches General Contractor", () => {
    const allPlumbing = runSeoChecks(
      "<title>Plumbing &amp; Sewer Services | Professional Plumbing</title><h1>Plumbing Services</h1>",
      { address: "3165 E Greenhurst Rd, Nampa, ID 83686, USA", category: "plumber" },
      null,
      null,
    );
    expect(allPlumbing.title_has_category).toBe(true);
    expect(allPlumbing.h1_has_category).toBe(true);
    expect(categoryPattern("general_contractor").test("Boise General Contractor")).toBe(true);
    expect(categoryPattern("general_contractor").test("Nampa Handyman & Remodeling")).toBe(true);
    expect(categoryPattern("plumber").test("Boise Electricians")).toBe(false);
    // Unknown types fall back to their last word, then the humanised type.
    expect(categoryPattern("mexican_restaurant").test("Best tacos — Casa Grill")).toBe(true);
    expect(categoryPattern("auto_parts_store").test("Auto Parts Store in Boise")).toBe(true);
  });

  it("every picker category matches how a page names it — and not its look-alikes", () => {
    const named: Array<[string, string]> = [
      ["plumber", "Plumbers"], ["electrician", "Electrical Services"], ["roofing_contractor", "Roofing & Repairs"],
      ["general_contractor", "Construction"], ["painter", "Painting Co"], ["locksmith", "Lock & Key"],
      ["moving_company", "Movers"], ["dentist", "Family Dental"], ["hair_salon", "Hair Studio"],
      ["beauty_salon", "Nail & Lash Bar"], ["spa", "Day Spa"], ["gym", "Fitness Center"],
      ["restaurant", "Bar & Grill"], ["cafe", "Coffee House"], ["car_repair", "Auto Repair"],
      ["car_wash", "Express Wash"], ["real_estate_agency", "Real Estate Group"], ["lawyer", "Smith Law"],
      ["veterinary_care", "Animal Hospital"], ["florist", "Flower Shop"], ["hvac_contractor", "Heating & Cooling"],
      ["landscaper", "Landscaping"], ["tanning_studio", "Spray Tan"], ["cosmetics_store", "Skincare"],
      ["educational_institution", "Beauty Academy"],
    ];
    for (const [type, text] of named) {
      expect(categoryPattern(type).test(text), `${type} ~ "${text}"`).toBe(true);
    }
    const lookalikes: Array<[string, string]> = [
      ["lawyer", "Lawn Care"], ["florist", "Florida Ave"], ["tanning_studio", "Tankless Water Heaters"],
      ["spa", "Spanish Spoken"], ["veterinary_care", "Vetted Pros"],
    ];
    for (const [type, text] of lookalikes) {
      expect(categoryPattern(type).test(text), `${type} !~ "${text}"`).toBe(false);
    }
  });

  it("detects local keywords in the measured elements", () => {
    const checks = runSeoChecks(
      good,
      { address: "1120 N Main St, Meridian, ID 83642", category: "plumber" },
      true,
      true,
    );
    expect(checks.title_has_city).toBe(true); // "… Meridian ID Plumber"
    expect(checks.title_has_category).toBe(true);
    expect(checks.h1_has_city).toBe(true);
    expect(checks.h1_has_category).toBe(true); // "…Trusted Plumbers…"
  });
});

describe("SEO guardrails (PRD 6.10)", () => {
  it("invariant rejects found=true with a null value", () => {
    const verdict = seoChecksInvariant({
      title: { found: true, value: null },
      meta_description: { found: false, value: null },
      h1_count: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("title");
  });

  it("rejects a local-fit score of 5 when meta description is missing", () => {
    const guardrail = makeSeoSummaryGuardrail({
      title: { found: true, value: "Boise Plumbers" },
      meta_description: { found: false, value: null },
      h1_count: 1,
    });
    const verdict = guardrail({
      local_fit_score_1_5: 5,
      reasoning: "Great page.",
      gaps: [],
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("meta description");
  });

  it("allows a 5 when title, meta, and H1 are all present", () => {
    const guardrail = makeSeoSummaryGuardrail({
      title: { found: true, value: "Boise Plumbers" },
      meta_description: { found: true, value: "Plumbing in Boise." },
      h1_count: 1,
    });
    expect(
      guardrail({ local_fit_score_1_5: 5, reasoning: "Complete.", gaps: [] })
        .passed,
    ).toBe(true);
  });
});

describe("template SEO summary + runSeo (fixture mode)", () => {
  it("flags the schema-missing dated Wix fixture with concrete gaps", async () => {
    const result = await runSeo({
      business: businessWith("8990 W Overland Rd, Boise ID", "plumber"),
      site: siteFor("boisedrainpros.wixsite.com"),
      hasSitemap: true,
      hasRobots: true,
    });
    expect(result.status).toBe("completed");
    expect(result.guardrailPassed).toBe(true);
    const output = result.output!;
    expect(output.has_schema).toBe(false);
    expect(output.summary.gaps).toContain("No schema.org structured data");
    expect(output.summary.gaps).toContain("Missing meta description");
    expect(output.summary.gaps).toContain("Title does not mention Boise");
    expect(output.summary.local_fit_score_1_5).toBeLessThanOrEqual(2);
  });

  it("scores the fully-optimized local site a legitimate 5", async () => {
    const result = await runSeo({
      business: businessWith("1120 N Main St, Meridian, ID 83642", "plumber"),
      site: siteFor("snakeriverplumbing.com"),
      hasSitemap: true,
      hasRobots: true,
    });
    const summary = result.output!.summary;
    // Title + meta description + H1 all present and locally targeted.
    expect(summary.local_fit_score_1_5).toBe(5);
    expect(summary.gaps).toEqual([]);
  });

  it("caps the score at 4 when the element set is incomplete (never a hollow 5)", async () => {
    const site = siteFor("snakeriverplumbing.com");
    const noMeta = {
      ...site,
      html: site.html.replace(/<meta name="description"[^>]*>/i, ""),
    };
    const result = await runSeo({
      business: businessWith("1120 N Main St, Meridian, ID 83642", "plumber"),
      site: noMeta,
      hasSitemap: true,
      hasRobots: true,
    });
    const summary = result.output!.summary;
    expect(summary.local_fit_score_1_5).toBe(4);
    expect(summary.gaps).toContain("Missing meta description");
  });

  it("treats unknown sitemap probes as unknown, not missing", () => {
    const checks = runSeoChecks(
      SITE_FIXTURES["snakeriverplumbing.com"]!.html,
      { address: null, category: null },
      null,
      null,
    );
    const summary = buildTemplateSeoSummary(checks);
    expect(checks.has_sitemap).toBeNull();
    expect(summary.gaps.join(" ")).not.toContain("sitemap");
  });

  it("fails cleanly when the homepage fetch failed", async () => {
    const result = await runSeo({
      business: businessWith(null, null),
      site: null,
      hasSitemap: null,
      hasRobots: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no HTML");
  });
});
