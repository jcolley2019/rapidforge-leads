/**
 * The model split (RFL.AI.9, audit §e), provider mocked: which model, effort
 * and output format each agent asks ai-core for.
 *   Health / Conversion / Presence / Reputation / SEO → template by default;
 *     Haiku 4.5 (no effort) only with AI_SUMMARIES=haiku.
 *   Design, Sales Summary → Sonnet 5.5 at effort "low"; Analyst stays Opus 4.8 (RFL.AI.9a).
 *   Builder Brief → Opus 4.8 at effort "low" (its Design Brief block: Haiku).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import type { AgentResult } from "@rapidforge/shared";
import { MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET } from "../lib/ai";
import { coreModeEnv, fakeProvider, jsonReply } from "../lib/ai.testkit";
import { FixturePsiClient } from "../lib/psi";
import { FixtureSiteFetcher, type FetchedSite } from "../lib/site";
import { runAnalyst } from "./analyst";
import { runBuilderBrief } from "./builder-brief";
import { runConversion } from "./conversion";
import { runDesign } from "./design";
import { runHealth } from "./health";
import { runPresence } from "./presence";
import { runReputation } from "./reputation";
import { runSalesSummary } from "./sales-summary";
import { runSeo } from "./seo";

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

const audit: Audit = {
  id: "aud-1",
  workspace_id: "ws-1",
  business_id: "biz-1",
  website_url: URL,
  ps_performance: 40,
  ps_mobile_performance: 32,
  ps_accessibility: 70,
  ps_seo: 60,
  ps_best_practices: 70,
  ps_lcp_ms: 4200,
  ps_cls: 0.2,
  http_status: 200,
  ssl_valid: true,
  response_ms: 900,
  platform: "wordpress",
  copyright_year: 2019,
  has_phone: false,
  has_form: false,
  has_booking: false,
  has_chat: false,
  has_viewport_meta: true,
  has_schema_markup: false,
  gbp_photo_count: null,
  gbp_review_velocity: null,
  has_crux_data: false,
  screenshot_desktop_url: null,
  screenshot_mobile_url: null,
  website_health_score: 36,
  star_grade: 2,
  sellability_score: 82,
  score_breakdown: {},
  issues: [
    { severity: "high", label: "Slow on mobile", detail: "Mobile perf 32/100" },
    { severity: "high", label: "No click-to-call", detail: "No tel: link" },
    { severity: "medium", label: "Dated design", detail: "Feels like 2016" },
  ],
  analyst_output: null,
  builder_brief_md: null,
  sales_summary: null,
  status: "completed",
  error_message: null,
  created_at: null,
  completed_at: "2026-07-05T00:00:00.000Z",
};

let site: FetchedSite | null;
let psi: Awaited<ReturnType<FixturePsiClient["run"]>>;
let restoreEnv: () => void = () => undefined;
let restoreProvider: () => void = () => undefined;

beforeEach(async () => {
  site = await new FixtureSiteFetcher().fetchHomepage(URL);
  psi = await new FixturePsiClient().run(URL, "mobile");
});
afterEach(() => {
  restoreProvider();
  restoreEnv();
});

/** The five narration agents, each run against the fixture site. */
const narration: Array<[string, () => Promise<AgentResult<Record<string, unknown>>>]> = [
  ["health", () => runHealth({ business, site, psiDesktop: psi, psiMobile: psi, now: NOW })],
  ["conversion", () => runConversion({ business, site })],
  ["presence", () => runPresence({ business, site })],
  ["reputation", () => runReputation({ business, previousAudit: null, now: NOW })],
  ["seo", () => runSeo({ business, site, hasSitemap: true, hasRobots: true })],
];

describe("narration summaries: template by default, Haiku 4.5 on AI_SUMMARIES=haiku", () => {
  it.each(narration)("%s with AI_SUMMARIES unset never calls the model and costs nothing", async (_name, run) => {
    restoreEnv = coreModeEnv();
    const p = fakeProvider(jsonReply({ anything: true }));
    restoreProvider = p.restore;
    const result = await run();
    expect(result.status).toBe("completed");
    expect(p.complete).not.toHaveBeenCalled();
    expect(result.modelUsed).toBeNull();
    expect(result.costCents).toBe(0);
    expect(result.costMicrocents).toBe(0);
    expect(result.guardrailPassed).toBe(true);
  });

  it.each(narration)("%s with AI_SUMMARIES=haiku asks Haiku 4.5 with structured output and no effort", async (_name, run) => {
    // The deterministic template passes the same guardrail — serve it back
    // as the "model" reply so the Haiku path completes end to end.
    restoreEnv = coreModeEnv();
    const templateRun = await run();
    const templateSummary = templateRun.output!.summary;
    restoreEnv();

    restoreEnv = coreModeEnv({ summaries: "haiku" });
    const p = fakeProvider(jsonReply(templateSummary));
    restoreProvider = p.restore;
    const result = await run();
    expect(p.requests).toHaveLength(1);
    const req = p.requests[0]!;
    expect(req.model).toBe(MODEL_HAIKU);
    expect(req.outputConfig?.effort).toBeUndefined();
    expect(req.outputConfig?.format?.type).toBe("json_schema");
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBe(MODEL_HAIKU);
    expect(result.guardrailPassed).toBe(true);
    expect(result.output!.summary).toEqual(templateSummary);
    // 1000 in @ $1/M + 500 out @ $5/M = 0.35¢: exact microcents kept, cents rounded (not ceiled to 1).
    expect(result.costMicrocents).toBe(350_000);
    expect(result.costCents).toBe(0);
  });
});

describe("narration summaries: AI_SUMMARIES=reputation picks one agent (RFL.FIX.3c)", () => {
  it.each(narration)("%s with AI_SUMMARIES=reputation calls Haiku only when it is reputation", async (name, run) => {
    restoreEnv = coreModeEnv();
    const templateRun = await run();
    const templateSummary = templateRun.output!.summary;
    restoreEnv();

    restoreEnv = coreModeEnv({ summaries: "reputation" });
    const p = fakeProvider(jsonReply(templateSummary));
    restoreProvider = p.restore;
    const result = await run();
    expect(result.status).toBe("completed");
    if (name === "reputation") {
      expect(p.requests).toHaveLength(1);
      expect(p.requests[0]!.model).toBe(MODEL_HAIKU);
      expect(result.modelUsed).toBe(MODEL_HAIKU);
    } else {
      expect(p.complete).not.toHaveBeenCalled();
      expect(result.modelUsed).toBeNull();
      expect(result.costCents).toBe(0);
    }
  });
});

describe("judgment agents", () => {
  beforeEach(() => {
    restoreEnv = coreModeEnv();
  });

  it("Design → Sonnet 5.5, effort low, both screenshots as image parts, structured output", async () => {
    const p = fakeProvider({ text: "not json" }); // → template; the request shape is what we assert
    restoreProvider = p.restore;
    const result = await runDesign({
      business,
      site,
      screenshots: {
        desktop: Buffer.from("desktop-jpeg-bytes"),
        mobile: Buffer.from("mobile-jpeg-bytes"),
        contentType: "image/jpeg",
      },
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(p.requests).toHaveLength(1);
    const req = p.requests[0]!;
    expect(req.model).toBe(MODEL_SONNET);
    expect(req.outputConfig?.effort).toBe("low");
    expect(req.outputConfig?.format?.type).toBe("json_schema");
    const user = req.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string }>;
    expect(parts.filter((c) => c.type === "image")).toHaveLength(2);
    expect(parts.at(-1)?.type).toBe("text");
  });

  it("Sales Summary → Sonnet 5.5, effort low", async () => {
    const p = fakeProvider({ text: "not json" });
    restoreProvider = p.restore;
    const result = await runSalesSummary({ business, audit, config: null });
    expect(result.status).toBe("completed");
    expect(p.requests[0]).toMatchObject({
      model: MODEL_SONNET,
      maxTokens: 1_200,
      outputConfig: { effort: "low", format: { type: "json_schema" } },
    });
  });

  it("Analyst stays Opus 4.8, effort low (RFL.AI.9a; gate unchanged)", async () => {
    const p = fakeProvider({ text: "not json" });
    restoreProvider = p.restore;
    const result = await runAnalyst({ business, audit, config: null });
    expect(result.status).toBe("completed");
    expect(p.requests[0]).toMatchObject({
      model: MODEL_OPUS,
      maxTokens: 1_500,
      outputConfig: { effort: "low", format: { type: "json_schema" } },
    });
  });

  it("Builder Brief stays Opus 4.8 at effort low (markdown, no format); its Design Brief block is Haiku without effort", async () => {
    const p = fakeProvider({ text: "## Goal\nstub" });
    restoreProvider = p.restore;
    const result = await runBuilderBrief({
      business,
      audit,
      config: null,
      competitors: [],
      siteHtmlExcerpt: "Snake River Plumbing — water heaters, drains, repipes.",
    });
    expect(result.status).toBe("completed");
    const models = new Set(p.requests.map((r) => r.model));
    expect(models).toEqual(new Set([MODEL_OPUS, MODEL_HAIKU]));
    const brief = p.requests.find((r) => r.model === MODEL_OPUS)!;
    // RFL.VERIFY.3 V1: one call at the 8,000 cap, request timeout = the budget.
    expect(brief.maxTokens).toBe(8_000);
    expect(brief.timeoutMs).toBe(120_000);
    expect(brief.outputConfig).toEqual({ effort: "low" });
    const designBrief = p.requests.find((r) => r.model === MODEL_HAIKU)!;
    expect(designBrief.outputConfig?.effort).toBeUndefined();
    expect(designBrief.outputConfig?.format?.type).toBe("json_schema");
  });

  it("effort is never sent to Haiku by any agent (ai-core rejects it before the network)", async () => {
    restoreEnv();
    restoreEnv = coreModeEnv({ summaries: "haiku" });
    const p = fakeProvider({ text: "not json" });
    restoreProvider = p.restore;
    for (const [, run] of narration) await run();
    await runBuilderBrief({ business, audit, config: null, competitors: [], siteHtmlExcerpt: null });
    const haikuRequests = p.requests.filter((r) => r.model === MODEL_HAIKU);
    expect(haikuRequests.length).toBeGreaterThanOrEqual(6);
    expect(haikuRequests.every((r) => r.outputConfig?.effort === undefined)).toBe(true);
  });
});
