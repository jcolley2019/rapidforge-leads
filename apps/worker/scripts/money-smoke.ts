/**
 * Sprint 7 LIVE smoke — the money agents' real model paths on ONE fixture
 * lead (a dated Wix plumber). Analyst + Builder Brief run on Fable 5 (with
 * the refusal→Opus retry); Sales Summary on Sonnet.
 *
 *   npx tsx scripts/money-smoke.ts
 *
 * MUST run WITHOUT RAPIDFORGE_FORCE_FIXTURES so aiSummaryMode() = "core".
 * Hard spend cap ~$2 (PRD Section 8 cost discipline).
 */
import "dotenv/config";
import type { Audit, Business } from "@rapidforge/shared";
import { runAnalyst } from "../src/agents/analyst";
import { runBuilderBrief } from "../src/agents/builder-brief";
import { runSalesSummary } from "../src/agents/sales-summary";
import { aiSummaryMode } from "../src/lib/ai";
import { countWords } from "../src/agents/guardrails/analyst";

const CAP_CENTS = 200; // ~$2 hard ceiling

const business = {
  id: "smoke-1",
  workspace_id: "ws-1",
  google_place_id: "fx-smoke",
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
} satisfies Business;

const audit = {
  id: "smoke-aud",
  workspace_id: "ws-1",
  business_id: "smoke-1",
  website_url: business.website_url,
  ps_performance: 41,
  ps_mobile_performance: 32,
  ps_accessibility: 74,
  ps_seo: 66,
  ps_best_practices: 70,
  ps_lcp_ms: 4200,
  ps_cls: 0.21,
  http_status: 200,
  ssl_valid: true,
  response_ms: 910,
  platform: "wix",
  copyright_year: 2021,
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
  score_breakdown: {
    v15_agents: {
      design: {
        modernity_0_100: 38,
        feels_like_year: 2016,
        critical_issues: [{ issue: "Dated hero", evidence: "flat stock banner" }],
      },
      reputation: {
        google_rating: 4.5,
        review_count: 89,
        volume_band: "high",
        review_velocity_per_month: 1.8,
        summary: { verdict: "solid" },
      },
      seo: {
        title: { found: true },
        meta_description: { found: false },
        has_sitemap: false,
        summary: { local_fit_score_1_5: 2 },
      },
    },
  },
  issues: [
    { severity: "high", label: "Mobile page speed is failing", detail: "32/100" },
    { severity: "high", label: "No click-to-call", detail: "no tel: link" },
    { severity: "medium", label: "Built on Wix" },
    { severity: "medium", label: "Copyright year is 2021" },
    { severity: "low", label: "Missing meta description" },
  ],
  analyst_output: null,
  builder_brief_md: null,
  sales_summary: null,
  status: "completed",
  error_message: null,
  created_at: null,
  completed_at: "2026-07-05T00:00:00.000Z",
} satisfies Audit;

async function main() {
  const mode = aiSummaryMode();
  console.log(`ai_mode: ${mode}`);
  if (mode !== "core") {
    console.log(
      "aiSummaryMode is not 'core' (ANTHROPIC_API_KEY missing or force-fixtures). LIVE smoke BLOCKED — set the key and re-run.",
    );
    return;
  }

  let spent = 0;

  console.log(`\n=== Analyst (Fable 5) — ${business.name} ===`);
  const analyst = await runAnalyst({ business, audit, config: null });
  spent += analyst.costCents;
  if (analyst.output) {
    console.log(`  verdict: ${analyst.output.verdict} / ${analyst.output.sales_lead_priority}`);
    console.log(`  one-liner: ${analyst.output.one_line_verdict}`);
    console.log(`  reasoning: ${analyst.output.reasoning}`);
    analyst.output.top_3_improvements.forEach((i) =>
      console.log(`  ${i.priority}. ${i.improvement} — ${i.estimated_impact}`),
    );
  }
  console.log(
    `  model: ${analyst.modelUsed}  guardrail: ${analyst.guardrailPassed}${analyst.guardrailNotes ? " — " + analyst.guardrailNotes : ""}  cost: ${analyst.costCents}¢`,
  );

  const auditWithAnalyst = { ...audit, analyst_output: analyst.output };

  if (spent < CAP_CENTS) {
    console.log(`\n=== Sales Summary (Sonnet) — ${business.name} ===`);
    const sales = await runSalesSummary({
      business,
      audit: auditWithAnalyst,
      config: null,
    });
    spent += sales.costCents;
    if (sales.output) {
      console.log(`  talk track (${countWords(sales.output.full_talk_track)} words):`);
      console.log(`  ${sales.output.full_talk_track}`);
      sales.output.anticipated_objections.forEach((o) =>
        console.log(`  · "${o.objection}" → ${o.response}`),
      );
    }
    console.log(
      `  model: ${sales.modelUsed}  guardrail: ${sales.guardrailPassed}${sales.guardrailNotes ? " — " + sales.guardrailNotes : ""}  cost: ${sales.costCents}¢`,
    );
  }

  if (spent < CAP_CENTS) {
    console.log(`\n=== Builder Brief (Fable 5) — ${business.name} ===`);
    const brief = await runBuilderBrief({
      business,
      audit: auditWithAnalyst,
      config: null,
      competitors: [
        {
          name: "Snake River Plumbing",
          google_rating: 4.7,
          review_count: 127,
          website_url: "https://snakeriverplumbing.com",
        },
      ],
      siteHtmlExcerpt: "Boise Drain Pros — drain cleaning and repair in Boise.",
    });
    spent += brief.costCents;
    if (brief.output) {
      console.log(
        `  ${brief.output.word_count} words · sections: ${brief.output.sections.length}/12`,
      );
      console.log(
        `  model: ${brief.modelUsed}  guardrail: ${brief.guardrailPassed}${brief.guardrailNotes ? " — " + brief.guardrailNotes : ""}  cost: ${brief.costCents}¢`,
      );
      console.log("\n----- BRIEF (first 1200 chars) -----");
      console.log(brief.output.markdown.slice(0, 1200));
      console.log("----- …truncated -----");
    }
  }

  console.log(`\nTOTAL SPEND: ${spent}¢ ($${(spent / 100).toFixed(2)})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
