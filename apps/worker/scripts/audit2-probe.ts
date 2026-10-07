/**
 * RFL.AUDIT.2 live probe — READ-ONLY against Supabase.
 *
 * Selects the 3 most recent completed audits since 2026-10-04 whose business
 * has a real website (website_kind = 'real', not a fixture id), preferring
 * different categories, and prints for each: business, scores + cap, every
 * agent_runs row for that audit, and each agent's stored output.
 *
 *   Run from apps/worker:  npx tsx scripts/audit2-probe.ts <mode> [args]
 *     count                       — list qualifying audits
 *     full                        — the 3-lead dump (Part 3)
 *     verify <audit_id> <html>    — re-run the deterministic parsers over a
 *                                   saved copy of the homepage and diff them
 *                                   against the stored audit
 *     prompts <audit_id>          — build every prompt for one stored audit
 *                                   with the real prompt functions; print sizes
 *     costs                       — agent_runs / usage_events aggregates since
 *                                   2026-10-04 (Part 5) + hygiene counts
 *   Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/worker/.env.
 *
 * Nothing is written. No model calls are made.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildIssues, type IssueInputs } from "@rapidforge/shared";
import { parseConversionSignals } from "../src/agents/conversion";
import { compareNap, findSocialLinks } from "../src/agents/presence";
import { runSeoChecks } from "../src/agents/seo";
import { cityFromPlacesAddress } from "../src/lib/address";
import { buildTemplateDesignCritique, computeTemplateModernity, readTemplateSignals } from "../src/agents/design";
import { buildAuditFacts } from "../src/agents/money-facts";
import { resolveConfigVars } from "../src/agents/prompts/config-vars";
import { buildAnalystPrompt, buildAnalystSystem } from "../src/agents/prompts/analyst";
import {
  BUILDER_BRIEF_SYSTEM,
  buildBuilderBriefPrompt,
  deriveKeywords,
} from "../src/agents/prompts/builder-brief";
import {
  buildSalesSummaryPrompt,
  buildSalesSummarySystem,
} from "../src/agents/prompts/sales-summary";
import { buildHealthSummaryPrompt, HEALTH_SUMMARY_SYSTEM } from "../src/agents/prompts/health";
import {
  buildConversionSummaryPrompt,
  CONVERSION_SUMMARY_SYSTEM,
} from "../src/agents/prompts/conversion";
import { buildPresenceSummaryPrompt, PRESENCE_SUMMARY_SYSTEM } from "../src/agents/prompts/presence";
import {
  buildReputationSummaryPrompt,
  REPUTATION_SUMMARY_SYSTEM,
} from "../src/agents/prompts/reputation";
import { buildSeoSummaryPrompt, buildSeoSummarySystem } from "../src/agents/prompts/seo";
import { resolveLocalTarget } from "../src/agents/prompts/config-vars";
import {
  buildDesignBriefJudgmentPrompt,
  DESIGN_BRIEF_JUDGMENT_SYSTEM,
} from "../src/agents/prompts/design-brief";
import { buildDesignPrompt, DESIGN_CRITIQUE_SYSTEM } from "../src/agents/prompts/design";
import { detectPlatform, extractCopyrightYear, extractLastModified, hasLegacyMarkup, hasRecentLastModified } from "../src/lib/platform";
import { assembleScores } from "../src/agents/scorer";
import { buildTemplateSeoSummary, type SeoOutput } from "../src/agents/seo";
import type { HealthOutput } from "../src/agents/health";
import type { ConversionOutput } from "../src/agents/conversion";
import type { PresenceOutput } from "../src/agents/presence";
import type { DesignOutput } from "../src/agents/design";
import { reviewTextsFrom } from "../src/agents/reputation";

const SINCE = "2026-10-04";
const mode = process.argv[2] ?? "count";

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in apps/worker/.env");
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (mode === "verify") return verify(db, process.argv[3]!, process.argv[4]!);
  if (mode === "prompts") return prompts(db, process.argv[3]!);
  if (mode === "costs") return costs(db);
  if (mode === "flagged") return flagged(db);

  const { data: audits, error } = await db
    .from("audits")
    .select("*, businesses!inner(*)")
    .eq("status", "completed")
    .gt("completed_at", SINCE)
    .eq("businesses.website_kind", "real")
    .not("businesses.google_place_id", "like", "fx-%")
    .order("completed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`audits: ${error.message}`);

  // Only full audits (health measured) — hot leads / dead / provisional are
  // not what Part 3 is about, but report them so the choice is visible.
  const all = audits ?? [];
  const full = all.filter(
    (a: any) => a.website_health_score !== null && a.provisional !== true,
  );
  console.log(`qualifying completed audits since ${SINCE} (real site, non-fixture): ${all.length}`);
  console.log(`  of which full (health measured, non-provisional): ${full.length}`);
  for (const a of all) {
    console.log(
      `  ${a.completed_at}  ${String(a.businesses.category).padEnd(22)} health=${fmt(a.website_health_score)} star=${fmt(a.star_grade)} sell=${fmt(a.sellability_score)} prov=${a.provisional} id=${a.id}  ${a.businesses.name}`,
    );
  }
  if (mode === "count") return;

  // Pick 3, preferring distinct categories, newest first.
  const picked: any[] = [];
  const seen = new Set<string>();
  for (const a of full) {
    if (picked.length === 3) break;
    if (seen.has(a.businesses.category)) continue;
    seen.add(a.businesses.category);
    picked.push(a);
  }
  for (const a of full) {
    if (picked.length === 3) break;
    if (!picked.includes(a)) picked.push(a);
  }

  for (const a of picked) {
    const b = a.businesses;
    console.log("\n" + "=".repeat(100));
    console.log(`LEAD: ${b.name}  [${b.category}]  ${b.website_url}`);
    console.log(`business_id=${b.id}  audit_id=${a.id}  completed_at=${a.completed_at}`);
    console.log(
      `places: rating=${fmt(b.google_rating)} reviews=${fmt(b.review_count)} phone=${b.phone} status=${b.business_status} chain=${b.is_chain}/${b.chain_reason} details=${b.places_details ? "yes" : "no"}`,
    );
    console.log(`address: ${b.address}`);
    console.log(
      `scores: health=${a.website_health_score} star=${a.star_grade} sellability=${a.sellability_score} capped=${a.score_breakdown?.capped ?? "-"} badge=${a.score_breakdown?.badge ?? "-"}`,
    );
    const cols = [
      "ps_performance", "ps_mobile_performance", "ps_accessibility", "ps_seo", "ps_best_practices",
      "ps_lcp_ms", "ps_cls", "http_status", "ssl_valid", "response_ms", "platform", "copyright_year",
      "has_phone", "has_form", "has_booking", "has_chat", "has_viewport_meta", "has_schema_markup",
      "gbp_photo_count", "gbp_review_velocity", "has_crux_data", "screenshot_desktop_url", "screenshot_mobile_url",
    ];
    console.log("audit columns: " + cols.map((c) => `${c}=${fmt(a[c])}`).join(" "));
    console.log("score_breakdown: " + JSON.stringify(a.score_breakdown, null, 1));
    console.log("issues: " + JSON.stringify(a.issues));
    console.log("analyst_output: " + JSON.stringify(a.analyst_output, null, 1));
    console.log("sales_summary: " + JSON.stringify(a.sales_summary, null, 1));
    console.log("design_brief: " + JSON.stringify(a.design_brief, null, 1));
    console.log("builder_brief_md: " + (a.builder_brief_md ? `${a.builder_brief_md.length} chars\n${a.builder_brief_md}` : "null"));

    // agent_runs: pipeline rows are keyed by target_id within the audit's time
    // window; on-demand rows carry input.audit_id.
    const { data: runs, error: runErr } = await db
      .from("agent_runs")
      .select("*")
      .eq("target_id", b.id)
      .gte("started_at", new Date(new Date(a.created_at).getTime() - 60_000).toISOString())
      .order("started_at", { ascending: true });
    if (runErr) throw new Error(`agent_runs: ${runErr.message}`);
    const rows = (runs ?? []).filter(
      (r: any) =>
        r.input?.audit_id === a.id ||
        new Date(r.started_at).getTime() <= new Date(a.completed_at).getTime() + 10 * 60_000,
    );
    console.log(`\nagent_runs (${rows.length}):`);
    for (const r of rows) {
      console.log(
        `  ${r.started_at}  ${String(r.agent_name).padEnd(14)} ${String(r.status).padEnd(9)} model=${fmt(r.model_used).padEnd(18)} tokens=${fmt(r.tokens_used).padStart(6)} cost=${fmt(r.cost_cents)}¢ guardrail=${r.guardrail_passed} dur=${fmt(r.duration_ms)}ms id=${r.id}${r.guardrail_notes ? `\n      notes: ${r.guardrail_notes}` : ""}${r.error ? `\n      error: ${r.error}` : ""}`,
      );
    }
    for (const r of rows) {
      console.log(`\n--- output: ${r.agent_name} (${r.id}) ---`);
      console.log(JSON.stringify(r.output, null, 1));
    }
    // Places details reviews — for quote verification
    const reviews = b.places_details?.reviews ?? [];
    console.log(`\nplaces_details: reviews=${reviews.length} photos=${b.places_details?.photos?.length ?? 0} hours=${b.places_details?.regularOpeningHours ? "yes" : "no"}`);
    for (const rv of reviews) {
      console.log(`  [${rv.rating}★] ${(rv.text?.text ?? rv.originalText?.text ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
    }
  }
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? "null" : String(v);
}

async function loadAudit(db: SupabaseClient, auditId: string): Promise<{ audit: any; business: any }> {
  const { data, error } = await db
    .from("audits")
    .select("*, businesses!inner(*)")
    .eq("id", auditId)
    .single();
  if (error) throw new Error(`audit ${auditId}: ${error.message}`);
  const { businesses, ...audit } = data as any;
  return { audit, business: businesses };
}

/** Re-run the deterministic parsers over a saved homepage; diff vs. stored. */
async function verify(db: SupabaseClient, auditId: string, htmlPath: string): Promise<void> {
  const { audit, business } = await loadAudit(db, auditId);
  const html = readFileSync(htmlPath, "utf8");
  const headersPath = htmlPath.replace(/\.html$/, ".headers");
  const headers: Record<string, string> = {};
  try {
    for (const line of readFileSync(headersPath, "utf8").split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  } catch {
    /* no headers file */
  }
  const v15 = audit.score_breakdown?.v15_agents ?? {};
  console.log(`VERIFY ${business.name} — ${business.website_url} — html ${html.length} chars (today's fetch)`);
  console.log(`address: ${business.address}`);
  console.log(`cityFromPlacesAddress (lib/address.ts) → ${JSON.stringify(cityFromPlacesAddress(business.address))}`);

  const conv = parseConversionSignals(html);
  const storedConv = v15.conversion ?? {};
  console.log("\nCONVERSION (today vs stored):");
  for (const k of ["has_tel_link", "has_visible_phone", "visible_phone", "form_count", "has_form", "has_booking", "booking_url", "has_chat", "has_viewport_meta", "has_schema_markup", "has_cta_above_fold", "cta_candidates", "cta_source"]) {
    const stored = k in storedConv ? storedConv[k] : k === "has_viewport_meta" ? audit.has_viewport_meta : k === "has_schema_markup" ? audit.has_schema_markup : k === "has_chat" ? audit.has_chat : k === "has_visible_phone" ? audit.has_phone : "(not stored)";
    console.log(`  ${k.padEnd(20)} today=${JSON.stringify((conv as any)[k])}  stored=${JSON.stringify(stored)}`);
  }
  console.log(`  tel_numbers today=${JSON.stringify(conv.tel_numbers)}`);

  const nap = compareNap(business, html);
  console.log("\nPRESENCE (today vs stored):");
  console.log(`  nap today=${JSON.stringify(nap)}`);
  console.log(`  nap stored=${JSON.stringify(v15.presence)}`);
  // The NAP bullets the Scorer would write from today's compare (RFL.FIX.3c).
  const napIssues = buildIssues({
    currentYear: new Date().getFullYear(),
    napConsistent: nap.nap_consistent,
    napAddressMatch: nap.nap_address_match,
    napGoogleStreet: nap.google_street,
  } as IssueInputs).filter((i) => /Google listing|Address not shown/.test(i.label));
  console.log(`  nap issues today=${JSON.stringify(napIssues)}`);
  console.log(`  social today=${JSON.stringify(findSocialLinks(html))}`);

  const seo = runSeoChecks(html, business, null, null);
  console.log("\nSEO (today vs stored):");
  for (const k of ["title", "meta_description", "h1s", "schema_types", "city", "category", "title_has_city", "title_has_category", "h1_has_city", "h1_has_category", "meta_has_city", "meta_has_category"]) {
    console.log(`  ${k.padEnd(20)} today=${JSON.stringify((seo as any)[k])}  stored=${JSON.stringify(v15.seo?.[k])}`);
  }

  console.log("\nHEALTH/DESIGN signals (today vs stored):");
  const platform = detectPlatform({ url: business.website_url ?? "", html, headers });
  const copyright = extractCopyrightYear(html, new Date().getFullYear());
  console.log(`  platform today=${platform} stored=${audit.platform}`);
  console.log(`  copyright_year today=${copyright} stored=${audit.copyright_year}`);
  console.log(`  last-modified header today=${headers["last-modified"] ?? "(none)"} server=${headers["server"] ?? "(none)"}`);
  const sig = readTemplateSignals(
    { html, httpStatus: 200, responseMs: 0, finalUrl: business.website_url ?? "", sslValid: true, headers },
    business.website_url ?? "",
    new Date(),
  );
  console.log(`  template design signals today=${JSON.stringify(sig)} → modernity ${computeTemplateModernity(sig)} (stored ${v15.design?.modernity_0_100}, used_vision=${v15.design?.used_vision})`);
  // RFL.FIX.3g: the Design issues the money agents would see today — the
  // template critique from today's markup, read back through money-facts.
  const critiqueToday = buildTemplateDesignCritique(sig, new Date());
  const factsToday = buildAuditFacts(business, {
    ...audit,
    score_breakdown: { ...(audit.score_breakdown ?? {}), v15_agents: { ...v15, design: { ...critiqueToday, used_vision: false } } },
  });
  console.log(`  design issues today (template)=${JSON.stringify(critiqueToday.critical_issues.map((i) => i.issue))}`);
  console.log(`  money-facts design.critical_issues today=${JSON.stringify(factsToday.design?.critical_issues)} stored-row-through-money-facts=${JSON.stringify(buildAuditFacts(business, audit).design?.critical_issues)}`);

  // RFL.FIX.3d: re-score with today's deterministic measurements over the
  // STORED PSI numbers (PSI is not re-run here) — before/after health, star,
  // sellability, platform and the issues list. Nothing is written.
  const now = new Date();
  const healthToday: HealthOutput = {
    ps_performance: audit.ps_performance,
    ps_mobile_performance: audit.ps_mobile_performance,
    desktop_measured: false,
    ps_accessibility: audit.ps_accessibility,
    ps_seo: audit.ps_seo,
    ps_best_practices: audit.ps_best_practices,
    ps_lcp_ms: audit.ps_lcp_ms,
    ps_cls: audit.ps_cls,
    ps_tbt_ms: null,
    has_crux_data: audit.has_crux_data,
    http_status: audit.http_status,
    response_ms: audit.response_ms,
    ssl_valid: audit.ssl_valid,
    https_enforced: String(business.website_url ?? "").startsWith("https://"),
    platform,
    copyright_year: copyright,
    has_recent_last_modified: hasRecentLastModified(headers, now),
    last_modified_at: extractLastModified(headers),
    legacy_markup: hasLegacyMarkup(html),
    summary: { reasoning: "", critical_issues: [], summary_one_liner: "" },
  };
  const conversionToday = { ...conv, summary: { cta_strength: "none", evidence: [], reasoning: "", summary_one_liner: "" } } as unknown as ConversionOutput;
  const presenceToday = {
    nap,
    social_links: findSocialLinks(html),
    gbp_photo_count: audit.gbp_photo_count,
    hours_completeness: "unknown",
    summary: {},
  } as unknown as PresenceOutput;
  const designToday = { ...critiqueToday, used_vision: false } as DesignOutput;
  const seoToday = { ...seo, summary: buildTemplateSeoSummary(seo) } as SeoOutput;
  const rescored = assembleScores({
    business,
    health: healthToday,
    conversion: conversionToday,
    presence: presenceToday,
    traffic: { has_crux_data: audit.has_crux_data, crux_mobile: null, crux_desktop: null },
    design: designToday,
    reputation: null,
    seo: seoToday,
    now,
    psiUnmeasured: audit.ps_mobile_performance === null,
  });
  const hb = rescored.scoreBreakdown.health as Record<string, unknown>;
  console.log("\nRESCORE (stored → today, stored PSI + today's markup/headers):");
  console.log(`  health      ${audit.website_health_score} → ${rescored.healthScore}`);
  console.log(`  star        ${audit.star_grade} → ${rescored.starGrade}`);
  console.log(`  sellability ${audit.sellability_score} (${audit.score_breakdown?.capped ?? "-"}) → ${rescored.sellabilityScore} (${rescored.scoreBreakdown.capped ?? "-"})`);
  console.log(`  platform    ${audit.platform} → ${rescored.platform} (detected ${healthToday.platform}; platform term ${hb.platform})`);
  console.log(`  health terms today=${JSON.stringify(hb)}`);
  console.log(`  issues stored=${JSON.stringify((audit.issues ?? []).map((i: any) => `${i.severity}:${i.label}`))}`);
  console.log(`  issues today =${JSON.stringify(rescored.issues.map((i) => `${i.severity}:${i.label}`))}`);
}

function sizeLine(label: string, system: string, prompt: string): void {
  const chars = system.length + prompt.length;
  console.log(
    `  ${label.padEnd(14)} system=${String(system.length).padStart(5)} prompt=${String(prompt.length).padStart(6)} total=${String(chars).padStart(6)} chars ≈ ${String(Math.round(chars / 4)).padStart(5)} tokens`,
  );
}

/** Build every prompt for one stored audit with the real prompt functions. */
async function prompts(db: SupabaseClient, auditId: string): Promise<void> {
  const { audit, business } = await loadAudit(db, auditId);
  const { data: cfg } = await db
    .from("workspace_config")
    .select("*")
    .eq("workspace_id", audit.workspace_id)
    .maybeSingle();
  const vars = resolveConfigVars((cfg as any) ?? null);
  const facts = buildAuditFacts(business, audit);
  console.log(`PROMPTS for ${business.name} (audit ${auditId})`);
  console.log(`workspace_config: ${JSON.stringify(cfg)}`);
  console.log(`resolved vars: ${JSON.stringify(vars)}`);
  console.log(`facts.agents_run: ${JSON.stringify(facts.agents_run)}`);

  // Narration agents: the prompt is the stored signals block minus `summary`.
  const { data: runs } = await db
    .from("agent_runs")
    .select("agent_name, output, started_at")
    .eq("target_id", business.id)
    .gte("started_at", new Date(new Date(audit.created_at).getTime() - 60_000).toISOString())
    .lte("started_at", new Date(new Date(audit.completed_at).getTime() + 10 * 60_000).toISOString());
  const outputOf = (agent: string): Record<string, unknown> | null => {
    const r = (runs ?? []).find((x: any) => x.agent_name === agent && x.output);
    if (!r) return null;
    const { summary: _s, ...rest } = r.output as Record<string, unknown>;
    return rest;
  };
  console.log("\nsizes (chars; tokens ≈ chars/4):");
  const h = outputOf("health");
  if (h) sizeLine("health", HEALTH_SUMMARY_SYSTEM, buildHealthSummaryPrompt(h));
  const c = outputOf("conversion");
  if (c) sizeLine("conversion", CONVERSION_SUMMARY_SYSTEM, buildConversionSummaryPrompt(c));
  const p = outputOf("presence");
  if (p) {
    const nap = (p.nap as Record<string, unknown>) ?? {};
    sizeLine("presence", PRESENCE_SUMMARY_SYSTEM, buildPresenceSummaryPrompt({ business_name: business.name, ...nap, social_links: p.social_links }));
  }
  const r = outputOf("reputation");
  if (r) {
    const reviews = reviewTextsFrom(business.places_details);
    const { reviews_considered: _rc, review_count_at_audit: _rca, yelp_rating: _y, yelp_review_count: _yc, rating_divergence: _rd, ...signals } = r;
    sizeLine("reputation", REPUTATION_SUMMARY_SYSTEM, buildReputationSummaryPrompt({ ...signals, yelp_available: false, review_text_available: reviews.length > 0, ...(reviews.length > 0 ? { reviews } : {}) }));
  }
  const s = outputOf("seo");
  if (s) sizeLine("seo", buildSeoSummarySystem(resolveLocalTarget(s.category, s.city)), buildSeoSummaryPrompt(s));
  sizeLine("design(vision)", DESIGN_CRITIQUE_SYSTEM, buildDesignPrompt(business.website_url ?? ""));
  const analystPrompt = buildAnalystPrompt(facts, vars);
  const analystSystem = buildAnalystSystem(vars);
  sizeLine("analyst", analystSystem, analystPrompt);
  const keywords = deriveKeywords(facts);
  const briefPrompt = buildBuilderBriefPrompt(facts, vars, [], keywords, "x".repeat(1500));
  sizeLine("builder-brief", BUILDER_BRIEF_SYSTEM, briefPrompt);
  const salesPrompt = buildSalesSummaryPrompt(facts, vars, (audit.analyst_output as any) ?? null);
  sizeLine("sales-summary", buildSalesSummarySystem(vars), salesPrompt);
  const dbPrompt = buildDesignBriefJudgmentPrompt({
    category: business.category ?? "local_service",
    homepage_excerpt: "x".repeat(1500),
    headings: audit.score_breakdown?.v15_agents?.seo?.h1s ?? [],
    review_texts: reviewTextsFrom(business.places_details).map((t) => t.text.slice(0, 400)),
  });
  sizeLine("design-brief", DESIGN_BRIEF_JUDGMENT_SYSTEM, dbPrompt);
  console.log(`\nderiveKeywords → ${JSON.stringify(keywords)}`);
  console.log("\n--- ANALYST SYSTEM (verbatim, config substituted) ---\n" + analystSystem);
  console.log("\n--- SALES SUMMARY SYSTEM (verbatim, config substituted) ---\n" + buildSalesSummarySystem(vars));
  console.log("\n--- ANALYST PROMPT (verbatim) ---\n" + analystPrompt);
  console.log("\n--- SEO PROMPT (verbatim) ---\n" + (s ? buildSeoSummaryPrompt(s) : "(no seo run)"));
}

/** Guardrail-flagged and fell-back runs since SINCE, with notes; recent searches. */
async function flagged(db: SupabaseClient): Promise<void> {
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("id, agent_name, model_used, status, tokens_used, cost_cents, guardrail_passed, guardrail_notes, error, started_at, target_id")
    .gte("started_at", SINCE)
    .or("guardrail_passed.eq.false,status.neq.completed,and(model_used.is.null,tokens_used.gt.0)")
    .order("started_at", { ascending: true });
  if (error) throw new Error(error.message);
  console.log(`flagged / failed / fell-back agent_runs since ${SINCE}: ${(runs ?? []).length}`);
  for (const r of (runs ?? []) as any[]) {
    console.log(`  ${r.started_at} ${String(r.agent_name).padEnd(12)} ${String(r.status).padEnd(9)} model=${fmt(r.model_used)} tokens=${r.tokens_used} cost=${r.cost_cents}¢ guardrail=${r.guardrail_passed} biz=${r.target_id} id=${r.id}`);
    if (r.guardrail_notes) console.log(`      notes: ${String(r.guardrail_notes).slice(0, 400)}`);
    if (r.error) console.log(`      error: ${String(r.error).slice(0, 300)}`);
  }
  const { data: searches } = await db
    .from("searches")
    .select("id, category, mode, params, status, results_count, created_at")
    .order("created_at", { ascending: false })
    .limit(6);
  console.log("\nmost recent searches (any date):");
  for (const s of (searches ?? []) as any[]) console.log(`  ${s.created_at} ${s.category} ${s.mode} ${JSON.stringify(s.params)} status=${s.status} results=${s.results_count} id=${s.id}`);
}

/** Part 5 aggregates — real agent_runs/usage_events since SINCE, plus hygiene. */
async function costs(db: SupabaseClient): Promise<void> {
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("agent_name, model_used, status, tokens_used, cost_cents, guardrail_passed, duration_ms, started_at, input, target_id")
    .gte("started_at", SINCE)
    .order("started_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = runs ?? [];
  console.log(`agent_runs since ${SINCE}: ${rows.length}`);
  const groups = new Map<string, { n: number; tokens: number; cost: number; dur: number; failed: number; flagged: number }>();
  for (const r of rows as any[]) {
    const k = `${r.agent_name} | ${r.model_used ?? "template/none"}`;
    const g = groups.get(k) ?? { n: 0, tokens: 0, cost: 0, dur: 0, failed: 0, flagged: 0 };
    g.n += 1;
    g.tokens += r.tokens_used ?? 0;
    g.cost += r.cost_cents ?? 0;
    g.dur += r.duration_ms ?? 0;
    if (r.status !== "completed") g.failed += 1;
    if (r.guardrail_passed === false) g.flagged += 1;
    groups.set(k, g);
  }
  console.log("agent | model                      n   avg_tokens  sum_cost¢  avg_cost¢  avg_ms  failed  flagged");
  for (const [k, g] of [...groups.entries()].sort()) {
    console.log(`  ${k.padEnd(36)} ${String(g.n).padStart(3)}  ${String(Math.round(g.tokens / g.n)).padStart(10)}  ${String(g.cost).padStart(9)}  ${(g.cost / g.n).toFixed(2).padStart(9)}  ${String(Math.round(g.dur / g.n)).padStart(6)}  ${String(g.failed).padStart(6)}  ${String(g.flagged).padStart(7)}`);
  }
  // Per audited business: pipeline cost (runs with input.search_id, excluding filter/scout/scorer)
  const perBiz = new Map<string, number>();
  for (const r of rows as any[]) {
    if (!r.target_id || r.input?.on_demand) continue;
    perBiz.set(r.target_id, (perBiz.get(r.target_id) ?? 0) + (r.cost_cents ?? 0));
  }
  const costsArr = [...perBiz.values()];
  console.log(`\nbusinesses touched by pipeline runs: ${perBiz.size}; total logged cost ${costsArr.reduce((a, b) => a + b, 0)}¢; mean ${(costsArr.reduce((a, b) => a + b, 0) / Math.max(1, perBiz.size)).toFixed(2)}¢/business (agent_runs.cost_cents, rounded per run)`);

  const { data: usage } = await db
    .from("usage_events")
    .select("event_type, cost_cents, metadata, created_at")
    .gte("created_at", SINCE);
  const byType = new Map<string, { n: number; cost: number }>();
  for (const u of (usage ?? []) as any[]) {
    const g = byType.get(u.event_type) ?? { n: 0, cost: 0 };
    g.n += 1;
    g.cost += u.cost_cents ?? 0;
    byType.set(u.event_type, g);
  }
  console.log(`\nusage_events since ${SINCE}:`);
  for (const [k, g] of byType) console.log(`  ${k.padEnd(16)} n=${String(g.n).padStart(4)}  cost=${g.cost}¢`);
  const auditRuns = ((usage ?? []) as any[]).filter((u) => u.event_type === "audit_run");
  if (auditRuns.length) {
    const c = auditRuns.map((u) => u.cost_cents ?? 0);
    console.log(`  audit_run per-lead AI cost: n=${c.length} mean=${(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2)}¢ min=${Math.min(...c)} max=${Math.max(...c)}`);
  }
  const placesByEndpoint = new Map<string, { n: number; cost: number }>();
  for (const u of (usage ?? []) as any[]) {
    if (u.event_type !== "places_call") continue;
    const ep = u.metadata?.endpoint ?? "?";
    const g = placesByEndpoint.get(ep) ?? { n: 0, cost: 0 };
    g.n += 1;
    g.cost += u.cost_cents ?? 0;
    placesByEndpoint.set(ep, g);
  }
  for (const [k, g] of placesByEndpoint) console.log(`  places:${k.padEnd(10)} n=${String(g.n).padStart(4)}  cost=${g.cost}¢`);

  // Hygiene (finding 9) + audit status mix
  const { count: fx } = await db.from("businesses").select("id", { count: "exact", head: true }).like("google_place_id", "fx-%");
  const { count: realBiz } = await db.from("businesses").select("id", { count: "exact", head: true }).not("google_place_id", "like", "fx-%");
  console.log(`\nbusinesses: fixture (fx-%) = ${fx}, real = ${realBiz}`);
  const { data: audits } = await db.from("audits").select("status, provisional, website_health_score, analyst_output, sales_summary, builder_brief_md, design_brief, completed_at").gte("created_at", SINCE);
  const a = (audits ?? []) as any[];
  const by = (f: (x: any) => boolean) => a.filter(f).length;
  console.log(`audits since ${SINCE}: ${a.length} — completed ${by((x) => x.status === "completed")}, skipped ${by((x) => x.status === "skipped")}, pending ${by((x) => x.status === "pending")}, failed ${by((x) => x.status === "failed")}, provisional ${by((x) => x.provisional)}, hot-lead(health null & completed) ${by((x) => x.status === "completed" && x.website_health_score === null && !x.provisional)}, analyst_output ${by((x) => x.analyst_output)}, sales_summary ${by((x) => x.sales_summary)}, builder_brief ${by((x) => x.builder_brief_md)}, design_brief ${by((x) => x.design_brief)}`);
  const { data: searches } = await db.from("searches").select("id, category, mode, params, status, results_count, created_at").gte("created_at", SINCE).order("created_at");
  console.log(`\nsearches since ${SINCE}:`);
  for (const s of (searches ?? []) as any[]) console.log(`  ${s.created_at} ${s.category} ${s.mode} ${JSON.stringify(s.params)} status=${s.status} results=${s.results_count}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
