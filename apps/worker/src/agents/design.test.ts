import { describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import type { FetchedSite } from "../lib/site";
import { SITE_FIXTURES } from "../lib/site-fixtures";
import {
  buildTemplateDesignCritique,
  computeTemplateModernity,
  hasLegacyMarkup,
  readTemplateSignals,
  runDesign,
  TEMPLATE_NOTE_PREFIX,
} from "./design";
import { designCritiqueGuardrail } from "./guardrails/design-critique";
import type { DesignCritique } from "./prompts/design";

const NOW = new Date("2026-07-05T12:00:00Z");

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

function businessFor(url: string | null): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-test",
    name: "Test Business",
    phone: null,
    website_url: url,
    address: null,
    lat: null,
    lng: null,
    google_rating: null,
    review_count: null,
    category: null,
    business_status: null,
    is_chain: false,
    website_kind: "real",
    last_refreshed_at: null,
    first_seen_at: NOW.toISOString(),
  } as Business;
}

function validCritique(): DesignCritique {
  const note =
    "The hero headline uses a condensed grotesque over a full-bleed photo with strong contrast and consistent spacing throughout the page.";
  const dim = { score_0_100: 80, notes: note };
  return {
    modernity_0_100: 80,
    dimensions: {
      typography: { ...dim },
      color: { ...dim },
      imagery: { ...dim },
      layout: { ...dim },
      mobile: { ...dim },
    },
    feels_like_year: 2025,
    reasoning: "Modern, competent build.",
    critical_issues: [],
  };
}

describe("designCritiqueGuardrail (PRD 6.8)", () => {
  it("passes a specific, consistent critique", () => {
    expect(designCritiqueGuardrail(validCritique()).passed).toBe(true);
  });

  it("rejects vague dimension notes under 15 words", () => {
    const critique = validCritique();
    critique.dimensions.color.notes = "Looks unprofessional and dated.";
    const verdict = designCritiqueGuardrail(critique);
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("'color'");
  });

  it("rejects a modern feels_like_year on a dated modernity score", () => {
    const critique = validCritique();
    critique.modernity_0_100 = 40;
    critique.feels_like_year = 2026;
    critique.critical_issues = [
      { issue: "Dated hero", evidence: "Stretched low-resolution hero photograph pixelates badly" },
    ];
    const verdict = designCritiqueGuardrail(critique);
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("inconsistent year/score");
  });

  it("rejects empty critical_issues when modernity < 70", () => {
    const critique = validCritique();
    critique.modernity_0_100 = 45;
    critique.feels_like_year = 2014;
    critique.critical_issues = [];
    const verdict = designCritiqueGuardrail(critique);
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("empty critical_issues");
  });

  it("rejects critical issues without specific evidence", () => {
    const critique = validCritique();
    critique.critical_issues = [{ issue: "Bad design", evidence: "ugly" }];
    const verdict = designCritiqueGuardrail(critique);
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("not specific");
  });
});

describe("template design critique (deterministic)", () => {
  it("scores the dated Wix fixture low with wix + copyright critical issues", () => {
    const url = "https://boisedrainpros.wixsite.com/home";
    const signals = readTemplateSignals(
      siteFor("boisedrainpros.wixsite.com"),
      url,
      NOW,
    );
    expect(signals.platform).toBe("wix");
    expect(signals.copyrightYear).toBe(2021);

    const critique = buildTemplateDesignCritique(signals, NOW);
    expect(critique.modernity_0_100).toBeLessThan(50);
    expect(critique.feels_like_year).toBeLessThanOrEqual(2019);
    const issues = critique.critical_issues.map((i) => i.issue).join(" | ");
    expect(issues).toContain("2021");
    expect(issues).toContain("wix");
    // The template must clear its own guardrail (CLAUDE.md 6.2 never
    // silently persists bad output — including our own).
    expect(designCritiqueGuardrail(critique).passed).toBe(true);
  });

  it("scores the ancient table-layout fixture at the bottom of the range", () => {
    const signals = readTemplateSignals(
      siteFor("meridianwaterheater.com"),
      "https://meridianwaterheater.com/",
      NOW,
    );
    expect(signals.hasViewportMeta).toBe(false);
    expect(signals.hasLegacyMarkup).toBe(true);
    const modernity = computeTemplateModernity(signals);
    expect(modernity).toBeLessThanOrEqual(15);
    const critique = buildTemplateDesignCritique(signals, NOW);
    expect(critique.feels_like_year).toBe(2006);
    expect(designCritiqueGuardrail(critique).passed).toBe(true);
  });

  it("flags Dreamweaver/align legacy markup (Accurbore-style page, RFL.FIX.3g)", () => {
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">
<html><head><title>Untitled Document</title>
<style>.twoColHybLt #container { width: 80%; }</style></head>
<body class="twoColHybLt"><div id="container"><div id="mainContent">
<h1 align="center">Accurbore, Inc.</h1>
<p style="font-family: Verdana, Arial, sans-serif;">Directional boring since 1998.</p>
</div></div></body></html>`;
    expect(hasLegacyMarkup(html)).toBe(true);
    // Each marker on its own.
    expect(hasLegacyMarkup('<h1 align="center">x</h1>')).toBe(true);
    expect(hasLegacyMarkup("<center>x</center>")).toBe(true);
    expect(hasLegacyMarkup('<meta name="generator" content="Microsoft FrontPage 4.0">')).toBe(true);
    expect(hasLegacyMarkup('<meta content="Adobe Dreamweaver CS3" name="generator">')).toBe(true);
    expect(hasLegacyMarkup('<p style="font-family:verdana">x</p>')).toBe(true);
    expect(hasLegacyMarkup('<div class="twoColFixLtHdr">x</div>')).toBe(true);
    // A modern page with none of them.
    expect(hasLegacyMarkup('<meta name="generator" content="WordPress 6.5"><div class="hero"><h1>x</h1></div>')).toBe(false);
    expect(hasLegacyMarkup('<div style="text-align:center">x</div>')).toBe(false);

    const signals = readTemplateSignals(
      { html, httpStatus: 200, responseMs: 100, finalUrl: "http://www.accurbore.com/", sslValid: false, headers: { server: "Microsoft-IIS/10.0" } },
      "http://www.accurbore.com/",
      NOW,
    );
    expect(signals.hasLegacyMarkup).toBe(true);
    expect(signals.hasViewportMeta).toBe(false);
    expect(computeTemplateModernity(signals)).toBeLessThanOrEqual(45);
    const critique = buildTemplateDesignCritique(signals, NOW);
    expect(critique.critical_issues.map((i) => i.issue)).toContain(
      "Page is built with legacy pre-CSS markup",
    );
    expect(designCritiqueGuardrail(critique).passed).toBe(true);
  });

  it("template dimension notes are marked as inference (no screenshot)", () => {
    const signals = readTemplateSignals(
      siteFor("snakeriverplumbing.com"),
      "https://snakeriverplumbing.com/",
      NOW,
    );
    const critique = buildTemplateDesignCritique(signals, NOW);
    for (const dim of Object.values(critique.dimensions)) {
      expect(dim.notes.startsWith(TEMPLATE_NOTE_PREFIX)).toBe(true);
      expect(dim.score_0_100).toBe(critique.modernity_0_100);
    }
  });

  it("scores a fresh custom site >= 70 with no forced issues", () => {
    const signals = readTemplateSignals(
      siteFor("snakeriverplumbing.com"),
      "https://snakeriverplumbing.com/",
      NOW,
    );
    const critique = buildTemplateDesignCritique(signals, NOW);
    expect(critique.modernity_0_100).toBeGreaterThanOrEqual(70);
    expect(critique.feels_like_year).toBe(2026);
    expect(critique.critical_issues).toEqual([]);
    expect(designCritiqueGuardrail(critique).passed).toBe(true);
  });
});

describe("runDesign (template mode)", () => {
  it("completes deterministically with no model and no cost", async () => {
    const url = "https://boisedrainpros.wixsite.com/home";
    const result = await runDesign({
      business: businessFor(url),
      site: siteFor("boisedrainpros.wixsite.com"),
      screenshots: null, // no images → template path, never a vision call
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBeNull();
    expect(result.costCents).toBe(0);
    expect(result.guardrailPassed).toBe(true);
    expect(result.output?.used_vision).toBe(false);
    expect(result.output?.modernity_0_100).toBeLessThan(50);
  });

  it("survives a null site (neutral critique, nothing invented)", async () => {
    const result = await runDesign({
      business: businessFor("https://unknown.example/"),
      site: null,
      screenshots: null,
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(result.output?.modernity_0_100).toBe(75);
    expect(result.output?.critical_issues).toEqual([]);
  });
});
