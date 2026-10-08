/**
 * Health agent (PRD 6.3) — measureHealth + the deterministic template +
 * the schema fix from RFL.FIX.3e (critical_issues[].value may be boolean;
 * the template never narrates a desktop score that was never measured).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import { MODEL_HAIKU } from "../lib/ai";
import { coreModeEnv, fakeProvider, jsonReply } from "../lib/ai.testkit";
import { FixturePsiClient, type PsiMetrics } from "../lib/psi";
import { FixtureSiteFetcher, type FetchedSite } from "../lib/site";
import { makeHealthSummaryGuardrail } from "./guardrails/health-summary";
import {
  buildTemplateHealthSummary,
  healthBand,
  measureHealth,
  platformLabel,
  runHealth,
  type HealthMeasurements,
} from "./health";
import { HealthSummarySchema } from "./prompts/health";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const URL = "https://snakeriverplumbing.com";

const business: Business = {
  id: "biz-1",
  workspace_id: "ws-1",
  google_place_id: "fx-001",
  name: "Snake River Plumbing Co",
  phone: "(208) 555-0101",
  website_url: URL,
  address: "1120 N Main St, Meridian, ID 83642",
  lat: 43.61,
  lng: -116.39,
  google_rating: 4.7,
  review_count: 127,
  category: "plumber",
  business_status: "OPERATIONAL",
  is_chain: false,
  website_kind: "real",
  first_seen_at: null,
  last_refreshed_at: null,
};

let site: FetchedSite;
let mobile: PsiMetrics;
let desktop: PsiMetrics;

beforeEach(async () => {
  site = (await new FixtureSiteFetcher().fetchHomepage(URL))!;
  mobile = (await new FixturePsiClient().run(URL, "mobile"))!;
  desktop = (await new FixturePsiClient().run(URL, "desktop"))!;
});

describe("measureHealth", () => {
  it("desktop off: psiDesktop is the mobile copy, so desktop_measured is false and ps_performance mirrors mobile", () => {
    const m = measureHealth({
      business,
      site,
      psiDesktop: mobile,
      psiMobile: mobile,
      desktopMeasured: false,
      now: NOW,
    });
    expect(m.desktop_measured).toBe(false);
    expect(m.ps_performance).toBe(mobile.performance);
    expect(m.ps_mobile_performance).toBe(mobile.performance);
  });

  it("infers desktop_measured from the two runs when the flag is omitted", () => {
    const copy = measureHealth({ business, site, psiDesktop: mobile, psiMobile: mobile, now: NOW });
    expect(copy.desktop_measured).toBe(false);
    const real = measureHealth({ business, site, psiDesktop: desktop, psiMobile: mobile, now: NOW });
    expect(real.desktop_measured).toBe(true);
    expect(real.ps_performance).toBe(desktop.performance);
  });

  it("null PSI: every PSI field is null (unknown), site facts still measured", () => {
    const m = measureHealth({ business, site, psiDesktop: null, psiMobile: null, now: NOW });
    expect(m.ps_performance).toBeNull();
    expect(m.ps_mobile_performance).toBeNull();
    expect(m.ps_lcp_ms).toBeNull();
    expect(m.has_crux_data).toBeNull();
    expect(m.desktop_measured).toBe(false);
    expect(m.http_status).toBe(site.httpStatus);
    expect(m.https_enforced).toBe(true);
    expect(m.platform).not.toBeNull();
  });

  it("null site: every site fact is null, nothing invented", () => {
    const m = measureHealth({ business, site: null, psiDesktop: mobile, psiMobile: mobile, now: NOW });
    expect(m.http_status).toBeNull();
    expect(m.response_ms).toBeNull();
    expect(m.ssl_valid).toBeNull();
    expect(m.https_enforced).toBeNull();
    expect(m.platform).toBeNull();
    expect(m.copyright_year).toBeNull();
    expect(m.has_recent_last_modified).toBe(false);
    expect(m.last_modified_at).toBeNull();
    expect(m.ps_mobile_performance).toBe(mobile.performance);
  });

  it("plumbs the Last-Modified date through as ISO beside the recent/not boolean (RFL.FIX.3k)", () => {
    const m = measureHealth({ business, site, psiDesktop: mobile, psiMobile: mobile, now: NOW });
    // Fixture header: Sat, 20 Jun 2026 08:12:00 GMT — 15 days before NOW.
    expect(m.last_modified_at).toBe("2026-06-20T08:12:00.000Z");
    expect(m.has_recent_last_modified).toBe(true);
    const old = measureHealth({
      business,
      site: { ...site, headers: { ...site.headers, "last-modified": "Wed, 21 Jun 2023 19:31:28 GMT" } },
      psiDesktop: mobile,
      psiMobile: mobile,
      now: NOW,
    });
    expect(old.last_modified_at).toBe("2023-06-21T19:31:28.000Z");
    expect(old.has_recent_last_modified).toBe(false);
  });
});

describe("buildTemplateHealthSummary", () => {
  function base(over: Partial<HealthMeasurements> = {}): HealthMeasurements {
    return {
      ps_performance: 99,
      ps_mobile_performance: 99,
      desktop_measured: false,
      ps_accessibility: 80,
      ps_seo: 70,
      ps_best_practices: 60,
      ps_lcp_ms: 2132,
      ps_cls: 0.01,
      ps_tbt_ms: 10,
      has_crux_data: false,
      http_status: 200,
      response_ms: 262,
      ssl_valid: false,
      https_enforced: false,
      platform: "custom",
      copyright_year: null,
      has_recent_last_modified: false,
      last_modified_at: null,
      legacy_markup: false,
      ...over,
    };
  }

  it("never claims a desktop score when desktop PSI was not run", () => {
    const s = buildTemplateHealthSummary(base());
    expect(s.reasoning).toContain("desktop not measured");
    expect(s.reasoning).not.toMatch(/desktop is \d+\/100/);
    expect(s.reasoning).toContain("99/100");
  });

  it("cites both strategies when desktop was really measured", () => {
    const s = buildTemplateHealthSummary(base({ desktop_measured: true, ps_performance: 95 }));
    expect(s.reasoning).toContain("mobile performance is 99/100 and desktop is 95/100");
    expect(s.reasoning).not.toContain("not measured");
  });

  it("with no PSI at all says the site is unmeasured and still passes its own guardrail", () => {
    const s = buildTemplateHealthSummary(
      base({ ps_performance: null, ps_mobile_performance: null, ps_lcp_ms: null }),
    );
    expect(s.summary_one_liner).toContain("unmeasured");
    expect(s.critical_issues.map((i) => i.metric)).toContain("ssl_valid");
    expect(makeHealthSummaryGuardrail(null)(s).passed).toBe(true);
  });

  it("flags poor mobile performance and clears the < 50 guardrail", () => {
    const s = buildTemplateHealthSummary(base({ ps_performance: 40, ps_mobile_performance: 40 }));
    expect(s.critical_issues.map((i) => i.metric)).toContain("ps_mobile_performance");
    expect(makeHealthSummaryGuardrail(40)(s).passed).toBe(true);
    expect(s.summary_one_liner).toContain("poor");
  });

  describe("with the Scorer's verdict (RFL.VERIFY.3 V4) — the one-liner follows the health band", () => {
    it("bands follow the star grade: 4–5★ healthy, 3★ middling, 1–2★ poor", () => {
      expect([85, 70, 69, 50, 49, 0].map(healthBand)).toEqual([
        "healthy",
        "healthy",
        "middling",
        "middling",
        "poor",
        "poor",
      ]);
      expect(platformLabel("legacy_static")).toBe("legacy static site");
      expect(platformLabel("wordpress")).toBe("wordpress");
    });

    it("healthy: 78 · 4★ custom", () => {
      const s = buildTemplateHealthSummary(base({ ssl_valid: true }), { healthScore: 78, platform: "custom" });
      expect(s.summary_one_liner).toBe(
        "Site is healthy: health 78/100 (4★), platform custom; mobile performance 99/100 with 0 critical issue(s).",
      );
      expect(makeHealthSummaryGuardrail(99)(s).passed).toBe(true);
    });

    it("middling: Accurbore's 60 · 3★ legacy_static page with PSI 99 never reads 'healthy' or 'custom'", () => {
      // Health itself detected "custom"; the Scorer classified legacy_static.
      const m = base({ platform: "custom", legacy_markup: true });
      expect(buildTemplateHealthSummary(m).summary_one_liner).toContain("Site is healthy"); // PSI alone
      const s = buildTemplateHealthSummary(m, { healthScore: 60, platform: "legacy_static" });
      expect(s.summary_one_liner).toBe(
        "Site is middling: health 60/100 (3★), a legacy static site; mobile performance 99/100 with 1 critical issue(s).",
      );
      expect(s.reasoning).toContain("Detected platform: legacy static site.");
      expect(`${s.summary_one_liner} ${s.reasoning}`).not.toMatch(/healthy|custom/);
      expect(makeHealthSummaryGuardrail(99)(s).passed).toBe(true);
    });

    it("poor: 40 · 2★ wix with mobile 40", () => {
      const s = buildTemplateHealthSummary(
        base({ platform: "wix", ps_performance: 40, ps_mobile_performance: 40 }),
        { healthScore: 40, platform: "wix" },
      );
      expect(s.summary_one_liner).toMatch(/^Site is poor: health 40\/100 \(2★\), platform wix; mobile performance 40\/100/);
      expect(makeHealthSummaryGuardrail(40)(s).passed).toBe(true);
    });
  });
});

describe("HealthSummarySchema (RFL.FIX.3e)", () => {
  it("accepts a boolean critical_issues[].value — the live reply that used to be unparseable", () => {
    const parsed = HealthSummarySchema.safeParse({
      reasoning: "Mobile performance is 99/100 and LCP is 2.1s.",
      critical_issues: [{ issue: "No valid SSL", metric: "ssl_valid", value: false }],
      summary_one_liner: "Fast but insecure.",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("runHealth with a replayed boolean-value reply", () => {
  let restoreProvider: () => void = () => {};
  let restoreEnv: () => void = () => {};
  afterEach(() => {
    restoreProvider();
    restoreEnv();
  });

  it("keeps the Haiku summary instead of falling to the template with model_used null", async () => {
    restoreEnv = coreModeEnv({ summaries: "haiku" });
    const reply = {
      reasoning: "Mobile performance scores 99/100 with an LCP of 2.1s, but the site serves over plain HTTP.",
      critical_issues: [{ issue: "No valid SSL", metric: "ssl_valid", value: false }],
      summary_one_liner: "Fast static page with no SSL.",
    };
    const p = fakeProvider(jsonReply(reply));
    restoreProvider = p.restore;
    const result = await runHealth({
      business,
      site,
      psiDesktop: mobile,
      psiMobile: mobile,
      desktopMeasured: false,
      now: NOW,
    });
    expect(p.requests).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBe(MODEL_HAIKU);
    expect(result.guardrailPassed).toBe(true);
    expect(result.output!.summary).toEqual(reply);
    expect(result.output!.desktop_measured).toBe(false);
    // The model is told the desktop number is a copy.
    expect(p.requests[0]!.messages.map((m) => String(m.content)).join(" ")).toContain('"desktop_measured": false');
  });
});
