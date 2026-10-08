import { describe, expect, it } from "vitest";
import { SITE_FIXTURES } from "../lib/site-fixtures";
import {
  ABOVE_FOLD_HTML_BYTES,
  aboveFoldSlice,
  buildTemplateConversionSummary,
  parseConversionSignals,
} from "./conversion";
import {
  isQuotableEvidence,
  makeConversionSummaryGuardrail,
} from "./guardrails/conversion-summary";

const html = (host: string) => SITE_FIXTURES[host]!.html;

describe("parseConversionSignals", () => {
  it("detects every signal on a fully-equipped page (snakeriver)", () => {
    const s = parseConversionSignals(html("snakeriverplumbing.com"));
    expect(s.has_tel_link).toBe(true);
    expect(s.tel_numbers).toContain("+12085550101");
    expect(s.has_visible_phone).toBe(true);
    expect(s.has_form).toBe(true);
    expect(s.max_form_fields).toBe(5);
    expect(s.has_booking).toBe(true);
    expect(s.booking_url).toContain("calendly.com");
    expect(s.has_viewport_meta).toBe(true);
    expect(s.has_schema_markup).toBe(true);
    expect(s.has_cta_above_fold).toBe(true);
    expect(s.has_chat).toBe(false);
  });

  it("sees the gaps on a weak page (boisedrainpros: no tel, no booking, no schema)", () => {
    const s = parseConversionSignals(html("boisedrainpros.wixsite.com"));
    expect(s.has_tel_link).toBe(false);
    expect(s.has_visible_phone).toBe(true); // phone is plain text only
    expect(s.has_booking).toBe(false);
    expect(s.has_schema_markup).toBe(false);
    expect(s.has_cta_above_fold).toBe(false); // "Send" is not a CTA verb
  });

  it("does not mistake social/facebook URLs for booking links", () => {
    const s = parseConversionSignals(
      '<a href="https://www.facebook.com/treasurevalleyplumbing">FB</a>',
    );
    expect(s.has_booking).toBe(false);
  });

  it("detects path-based scheduling links (rotorooter /schedule-service)", () => {
    const s = parseConversionSignals(html("www.rotorooter.com"));
    expect(s.has_booking).toBe(true);
    expect(s.has_chat).toBe(true); // livechat script
  });

  it("detects chat widgets by provider (tidio on gcgaragedoor)", () => {
    const s = parseConversionSignals(html("gcgaragedoor.com"));
    expect(s.has_chat).toBe(true);
    expect(s.chat_evidence).toBe("tidio");
    expect(s.has_tel_link).toBe(false);
    expect(s.has_visible_phone).toBe(false);
  });

  it("above-fold slice starts after </head>", () => {
    // Landers shape: a 31 KB head of JSON-LD pushed every body CTA past the
    // old 6,000-byte document-start slice (RFL.AUDIT.2 Part 2 §4).
    const head = `<head><script type="application/ld+json">${JSON.stringify({ text: "x".repeat(31_000) })}</script></head>`;
    const doc = `<!doctype html><html>${head}<body><main><a href="tel:+12082500058">Call (208) 250-0058</a></main></body></html>`;
    expect(aboveFoldSlice(doc).startsWith("<body>")).toBe(true);
    const s = parseConversionSignals(doc);
    expect(s.cta_candidates).toEqual(["Call (208) 250-0058"]);
    expect(s.has_cta_above_fold).toBe(true);
    expect(s.cta_source).toBe("body");
    // No </head>: from <body; neither: the document start (fragments).
    expect(aboveFoldSlice("<html><body><p>hi</p></body></html>").startsWith("<body>")).toBe(true);
    expect(aboveFoldSlice("<p>hi</p>")).toBe("<p>hi</p>");
    expect(aboveFoldSlice(`</head>${"y".repeat(9_000)}`)).toHaveLength(ABOVE_FOLD_HTML_BYTES);
  });

  it("nav-only Contact is not a CTA", () => {
    const navOnly = parseConversionSignals(
      `<body><header><nav><ul><li><a href="#home">Home</a></li><li><a href="#contact">Contact</a></li></ul></nav></header><main><h1>Plumbing</h1></main></body>`,
    );
    expect(navOnly.cta_candidates).toEqual([]);
    expect(navOnly.has_cta_above_fold).toBe(false);
    expect(navOnly.cta_source).toBeNull();
    // Accurbore: the menu is a <div id="sidebar1">, not a <nav>.
    const sidebar = parseConversionSignals(
      `</head><body><div id="container"><div id="sidebar1"><h3>Information</h3><p><a href="Contact.htm">Contact</a></p></div><div id="mainContent"><h1>Horizontal Earth Boring</h1></div></div></body>`,
    );
    expect(sidebar.has_cta_above_fold).toBe(false);
    // A real CTA in the header is kept, and says where it came from …
    const header = parseConversionSignals(
      `<body><header><a href="/estimate">Get Estimate</a><nav><a href="/contact">Contact</a></nav></header><main><p>Welcome</p></main></body>`,
    );
    expect(header.cta_candidates).toEqual(["Get Estimate"]);
    expect(header.cta_source).toBe("nav");
    // … and a body CTA wins the source; only a BARE Contact in chrome is dropped.
    const body = parseConversionSignals(
      `<body><nav><a href="/contact">Contact Us</a></nav><section class="hero"><a href="tel:+12083185701">Call Now</a></section></body>`,
    );
    expect(body.cta_candidates).toEqual(["Contact Us", "Call Now"]);
    expect(body.cta_source).toBe("body");
  });

  it("finds nothing to convert on the ancient site (meridianwaterheater)", () => {
    const s = parseConversionSignals(html("meridianwaterheater.com"));
    expect(s.has_viewport_meta).toBe(false);
    expect(s.has_form).toBe(false);
    expect(s.has_booking).toBe(false);
    expect(s.has_tel_link).toBe(false);
    expect(s.has_visible_phone).toBe(true);
  });

  it("strips a stray '=' from a tel: number (All Plumbing's \"=+12084394968\", RFL.VERIFY.3 V11)", () => {
    const s = parseConversionSignals(
      '<a href="tel:=+12084394968">Call Now</a> <a href="tel:+12084394968">208-439-4968</a>',
    );
    expect(s.tel_numbers).toEqual(["+12084394968", "+12084394968"]);
    expect(s.tel_numbers.some((n) => n.includes("="))).toBe(false);
    expect(s.has_tel_link).toBe(true);
  });
});

describe("buildTemplateConversionSummary", () => {
  it("classifies CTA strength deterministically and passes its own guardrail", () => {
    for (const host of [
      "snakeriverplumbing.com",
      "boisedrainpros.wixsite.com",
      "meridianwaterheater.com",
    ]) {
      const doc = html(host);
      const signals = parseConversionSignals(doc);
      const summary = buildTemplateConversionSummary(signals, doc);
      const verdict = makeConversionSummaryGuardrail(doc)(summary);
      expect(verdict.passed, `${host}: ${verdict.notes}`).toBe(true);
    }
    expect(
      buildTemplateConversionSummary(
        parseConversionSignals(html("snakeriverplumbing.com")),
        html("snakeriverplumbing.com"),
      ).cta_strength,
    ).toBe("strong");
    expect(
      buildTemplateConversionSummary(
        parseConversionSignals(html("boisedrainpros.wixsite.com")),
        html("boisedrainpros.wixsite.com"),
      ).cta_strength,
    ).toBe("weak");
  });

  it("guardrail rejects fabricated evidence quotes", () => {
    const doc = html("snakeriverplumbing.com");
    const signals = parseConversionSignals(doc);
    const summary = buildTemplateConversionSummary(signals, doc);
    const tampered = {
      ...summary,
      evidence: [{ element: "cta", quote: "Massive Discount Today Only!!" }],
    };
    expect(makeConversionSummaryGuardrail(doc)(tampered).passed).toBe(false);
  });

  it("guardrail rejects boolean literals as evidence", () => {
    // Landers run 1a803f5a…: "false" and "[]" occur in any page's scripts,
    // so the on-page check alone accepted them as "exact element text".
    const doc = `${html("snakeriverplumbing.com")}<script>var a = false; var b = []; var c = {}; var d = null; var e = true;</script>`;
    const guardrail = makeConversionSummaryGuardrail(doc);
    const base = buildTemplateConversionSummary(parseConversionSignals(doc), doc);
    for (const quote of ["false", "[]", "{}", "null", "true", " FALSE "]) {
      const verdict = guardrail({ ...base, cta_strength: "none", evidence: [{ element: "has_form", quote }] });
      expect(verdict.passed, quote).toBe(false);
      expect(verdict.notes).toMatch(/not element text/);
    }
    // One word without a digit is not element text either; a phone number is.
    expect(guardrail({ ...base, evidence: [{ element: "cta", quote: "Call" }] }).passed).toBe(false);
    expect(guardrail({ ...base, evidence: [{ element: "phone_text", quote: "(208) 555-0101" }] }).passed).toBe(true);
    expect(guardrail({ ...base, evidence: [{ element: "cta", quote: "Get My Free Quote" }] }).passed).toBe(true);
    expect(isQuotableEvidence("Contact")).toBe(false);
    expect(isQuotableEvidence("Call: (208) 250-0058")).toBe(true);
  });
});
