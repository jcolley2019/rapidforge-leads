import { describe, expect, it } from "vitest";
import { buildIssues, type IssueInputs } from "./issues";

/** A healthy site — produces zero issues. */
function healthyInputs(overrides: Partial<IssueInputs> = {}): IssueInputs {
  return {
    psMobilePerformance: 88,
    psDesktopPerformance: 92,
    psLcpMs: 1800,
    psCls: 0.03,
    sslValid: true,
    httpsEnforced: true,
    responseMs: 310,
    platform: "custom",
    copyrightYear: 2026,
    currentYear: 2026,
    hasVisiblePhone: true,
    hasClickToCall: true,
    hasForm: true,
    hasBooking: true,
    hasViewportMeta: true,
    hasSchemaMarkup: true,
    hasCruxData: true,
    napConsistent: true,
    // Sprint 6 agents — healthy defaults.
    designModernity: 82,
    designFeelsLikeYear: 2026,
    googleRating: 4.7,
    reviewCount: 120,
    seoLocalFitScore: 4,
    seoHasTitle: true,
    seoHasMetaDescription: true,
    seoHasSitemap: true,
    ...overrides,
  };
}

describe("buildIssues thresholds", () => {
  it("returns no issues for a healthy site", () => {
    expect(buildIssues(healthyInputs())).toEqual([]);
  });

  it("flags failing mobile performance as high severity", () => {
    const issues = buildIssues(healthyInputs({ psMobilePerformance: 22 }));
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "Mobile page speed is failing",
        detail: "PSI mobile performance 22/100",
      }),
    );
  });

  it("grades LCP into high (>4s) and medium (>2.5s) bands", () => {
    expect(
      buildIssues(healthyInputs({ psLcpMs: 8200 }))[0],
    ).toMatchObject({
      severity: "high",
      label: "Mobile page load is 8.2s (should be under 3)",
    });
    expect(buildIssues(healthyInputs({ psLcpMs: 3200 }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Mobile page load is 3.2s — misses the 2.5s good threshold",
      }),
    );
    expect(
      buildIssues(healthyInputs({ psLcpMs: 2200 })).filter((i) =>
        i.label.includes("page load"),
      ),
    ).toEqual([]);
  });

  it("flags missing SSL as high, unenforced HTTPS as medium (never both)", () => {
    const noSsl = buildIssues(healthyInputs({ sslValid: false }));
    expect(noSsl).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "Site is not served over valid HTTPS/SSL",
      }),
    );
    const unenforced = buildIssues(healthyInputs({ httpsEnforced: false }));
    expect(unenforced).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Site does not enforce HTTPS",
      }),
    );
    expect(noSsl.filter((i) => i.label.includes("HTTPS"))).toHaveLength(1);
  });

  it("flags slow server response at the 2s threshold", () => {
    expect(buildIssues(healthyInputs({ responseMs: 2000 }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Server response took 2000ms (should be under 2s)",
      }),
    );
    expect(
      buildIssues(healthyInputs({ responseMs: 1999 })).filter((i) =>
        i.label.startsWith("Server response"),
      ),
    ).toEqual([]);
  });

  it("names builder platforms (PRD 4.5 example: GoDaddy)", () => {
    expect(buildIssues(healthyInputs({ platform: "godaddy" }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Built on GoDaddy Website Builder",
      }),
    );
    expect(
      buildIssues(healthyInputs({ platform: "wordpress" })).filter((i) =>
        i.label.startsWith("Built on"),
      ),
    ).toEqual([]); // wordpress (65) is not a builder-tier platform
  });

  it("covers the conversion ladder: phone, tel link, form/booking", () => {
    expect(buildIssues(healthyInputs({ hasVisiblePhone: false }))).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "No visible phone number on the homepage",
      }),
    );
    expect(buildIssues(healthyInputs({ hasClickToCall: false }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Phone number is not clickable (no tel: link)",
      }),
    );
    expect(
      buildIssues(healthyInputs({ hasForm: false, hasBooking: false })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "No contact form or online booking",
      }),
    );
    expect(buildIssues(healthyInputs({ hasBooking: false }))).toContainEqual(
      expect.objectContaining({ severity: "low", label: "No online booking link" }),
    );
  });

  it("flags stale copyright only beyond the 2-year window", () => {
    expect(buildIssues(healthyInputs({ copyrightYear: 2019 }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Copyright year is 2019",
      }),
    );
    expect(
      buildIssues(healthyInputs({ copyrightYear: 2024 })).filter((i) =>
        i.label.startsWith("Copyright"),
      ),
    ).toEqual([]);
  });

  it("never invents issues from unknown (null) inputs", () => {
    const issues = buildIssues(
      healthyInputs({
        psMobilePerformance: null,
        psDesktopPerformance: null,
        psLcpMs: null,
        psCls: null,
        sslValid: null,
        httpsEnforced: null,
        responseMs: null,
        platform: null,
        copyrightYear: null,
        hasCruxData: null,
        napConsistent: null,
        designModernity: null,
        designFeelsLikeYear: null,
        googleRating: null,
        reviewCount: null,
        seoLocalFitScore: null,
        seoHasTitle: null,
        seoHasMetaDescription: null,
        seoHasSitemap: null,
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags dated design with the feels-like year (Sprint 6, PRD 6.8)", () => {
    expect(
      buildIssues(
        healthyInputs({ designModernity: 25, designFeelsLikeYear: 2010 }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "Site design looks dated — feels like 2010",
        detail: "Design modernity 25/100",
      }),
    );
    expect(
      buildIssues(healthyInputs({ designModernity: 52 })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Site design is behind current standards",
      }),
    );
    expect(
      buildIssues(healthyInputs({ designModernity: 60 })).filter((i) =>
        i.label.startsWith("Site design"),
      ),
    ).toEqual([]);
  });

  it("flags poor rating and thin review volume (Sprint 6, PRD 6.9)", () => {
    expect(
      buildIssues(healthyInputs({ googleRating: 3.1, reviewCount: 40 })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "Google rating is 3.1 — reputation is hurting conversions",
      }),
    );
    expect(
      buildIssues(healthyInputs({ reviewCount: 4 })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Only 4 Google reviews",
      }),
    );
    // A poor rating on 5 reviews is a volume problem, not a rating verdict.
    expect(
      buildIssues(
        healthyInputs({ googleRating: 2.8, reviewCount: 5 }),
      ).filter((i) => i.label.startsWith("Google rating")),
    ).toEqual([]);
  });

  it("flags SEO gaps (Sprint 6, PRD 6.10)", () => {
    expect(buildIssues(healthyInputs({ seoHasTitle: false }))).toContainEqual(
      expect.objectContaining({
        severity: "high",
        label: "Homepage is missing a <title> tag",
      }),
    );
    expect(
      buildIssues(healthyInputs({ seoHasMetaDescription: false })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Homepage has no meta description",
      }),
    );
    expect(
      buildIssues(healthyInputs({ seoLocalFitScore: 2 })),
    ).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Weak local SEO targeting",
        detail: "Local keyword fit 2/5",
      }),
    );
    expect(buildIssues(healthyInputs({ seoHasSitemap: false }))).toContainEqual(
      expect.objectContaining({ severity: "low", label: "No sitemap.xml" }),
    );
  });

  it("flags NAP mismatch and missing CrUX", () => {
    expect(buildIssues(healthyInputs({ napConsistent: false }))).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        label: "Phone or address on the site doesn't match the Google listing",
      }),
    );
    expect(buildIssues(healthyInputs({ hasCruxData: false }))).toContainEqual(
      expect.objectContaining({
        severity: "low",
        label: "No real-user traffic data in the Chrome UX Report",
      }),
    );
  });

  it("sorts most-severe first", () => {
    const issues = buildIssues(
      healthyInputs({
        hasCruxData: false, // low
        copyrightYear: 2018, // medium
        hasVisiblePhone: false, // high
      }),
    );
    expect(issues.map((i) => i.severity)).toEqual(["high", "medium", "low"]);
  });
});
