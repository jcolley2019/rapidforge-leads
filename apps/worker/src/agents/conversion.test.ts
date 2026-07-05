import { describe, expect, it } from "vitest";
import { SITE_FIXTURES } from "../lib/site-fixtures";
import {
  buildTemplateConversionSummary,
  parseConversionSignals,
} from "./conversion";
import { makeConversionSummaryGuardrail } from "./guardrails/conversion-summary";

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

  it("finds nothing to convert on the ancient site (meridianwaterheater)", () => {
    const s = parseConversionSignals(html("meridianwaterheater.com"));
    expect(s.has_viewport_meta).toBe(false);
    expect(s.has_form).toBe(false);
    expect(s.has_booking).toBe(false);
    expect(s.has_tel_link).toBe(false);
    expect(s.has_visible_phone).toBe(true);
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
});
