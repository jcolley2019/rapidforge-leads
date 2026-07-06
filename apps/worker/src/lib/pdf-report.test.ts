import { describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import {
  buildReportHtml,
  HtmlReportRenderer,
  reportFileStem,
  type ReportAnalyst,
} from "./pdf-report";

const business: Business = {
  id: "biz-1",
  workspace_id: "ws-1",
  google_place_id: "fx-1",
  name: "Boise Drain Pros",
  phone: "(208) 555-0102",
  website_url: "https://boisedrainpros.wixsite.com/home",
  address: "7800 W Fairview Ave, Boise, ID 83704",
  lat: 43.62,
  lng: -116.28,
  google_rating: 4.5,
  review_count: 89,
  category: "plumber",
  business_status: "OPERATIONAL",
  is_chain: false,
  website_kind: "real",
  first_seen_at: null,
  last_refreshed_at: null,
};

const audit = {
  id: "aud-1",
  website_health_score: 36,
  sellability_score: 82,
  star_grade: 2,
  platform: "wix",
  ps_mobile_performance: 32,
  ssl_valid: true,
  screenshot_desktop_url: null,
  screenshot_mobile_url: null,
  issues: [
    { severity: "high", label: "Mobile page speed is failing" },
    { severity: "medium", label: "Dated design" },
  ],
  analyst_output: null,
} as unknown as Audit;

const analyst: ReportAnalyst = {
  verdict: "needs_rebuild",
  one_line_verdict: "A dated Wix site leaving calls on the table.",
  top_3_improvements: [
    {
      priority: 1,
      improvement: "Rebuild mobile-first",
      rationale: "Mobile speed 32/100.",
      estimated_impact: "High",
    },
    {
      priority: 2,
      improvement: "Add click-to-call",
      rationale: "No tap-to-call.",
      estimated_impact: "High",
    },
    {
      priority: 3,
      improvement: "Modernize design",
      rationale: "Feels dated.",
      estimated_impact: "Moderate",
    },
  ],
};

const AT = new Date("2026-07-06T00:00:00.000Z");

describe("buildReportHtml", () => {
  it("produces a 2-page branded document with the key facts", () => {
    const html = buildReportHtml({ business, audit, analyst, generatedAt: AT });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Boise Drain Pros");
    expect(html).toContain("RAPIDFORGE");
    expect(html).toContain(">36<"); // health score
    expect(html).toContain(">82<"); // sellability
    expect(html).toContain("A dated Wix site leaving calls on the table.");
    expect(html).toContain("Mobile page speed is failing");
    expect(html).toContain("Rebuild mobile-first");
    expect(html).toContain("2026-07-06");
    // Two print pages.
    expect(html.match(/class="page"/g) ?? []).toHaveLength(2);
  });

  it("falls back to issues when there is no analyst verdict", () => {
    const html = buildReportHtml({
      business,
      audit,
      analyst: null,
      generatedAt: AT,
    });
    expect(html).not.toContain("Analyst verdict");
    expect(html).toContain("Mobile page speed is failing");
  });

  it("escapes HTML in business-controlled fields", () => {
    const html = buildReportHtml({
      business: { ...business, name: "A <script> & Co" },
      audit,
      analyst: null,
      generatedAt: AT,
    });
    expect(html).toContain("A &lt;script&gt; &amp; Co");
    expect(html).not.toContain("<script>");
  });
});

describe("HtmlReportRenderer", () => {
  it("returns the HTML as text/html bytes (no Chrome)", async () => {
    const renderer = new HtmlReportRenderer();
    const out = await renderer.render("<html>hi</html>");
    expect(renderer.mode).toBe("html");
    expect(out.contentType).toBe("text/html");
    expect(out.extension).toBe("html");
    expect(out.bytes.toString("utf8")).toBe("<html>hi</html>");
  });
});

describe("reportFileStem", () => {
  it("derives a filesystem-safe stem from the site", () => {
    expect(reportFileStem(business)).toBe("boisedrainpros-wixsite-com-audit-report");
  });
});
