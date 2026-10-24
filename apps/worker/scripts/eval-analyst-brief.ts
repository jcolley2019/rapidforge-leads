/**
 * RFL.EVAL.5 — blind eval: Analyst + Builder Brief, Opus 4.8 vs Sonnet 5.5.
 *
 *   Run from apps/worker:  npx tsx scripts/eval-analyst-brief.ts [--dry-run]
 *
 * MUST run WITHOUT RAPIDFORGE_FORCE_FIXTURES so aiSummaryMode() = "core".
 * Reads Supabase with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; NOTHING is
 * written to Supabase (the agents are called directly, not through the
 * on-demand route, so no agent_runs / usage_events / audit columns change).
 *
 * Leads: every business whose display audit (newest completed) passes the
 * production Analyst gate (analystEligible), sorted by business id, first 20.
 * Per lead: Analyst ×2 and Builder Brief ×2 (Opus, Sonnet), then one blind
 * Sonnet 5.5 judge call per pair with A/B drawn from a seeded RNG.
 *
 * Hard cap $8.00: every paid call reserves its projected cost first and is
 * skipped once the reservation would cross the cap; the report is written
 * from whatever completed. Raw outputs land in apps/worker/.eval/<timestamp>/
 * (gitignored); the report in docs/EVAL-2026-10-24.md.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { z, type ZodType } from "zod";
import type { AgentResult, Audit, Business, WorkspaceConfig } from "@rapidforge/shared";
import { runAnalyst } from "../src/agents/analyst";
import { briefBusinessInputsOf, runBuilderBrief, type BuilderBriefOutput } from "../src/agents/builder-brief";
import { DESIGN_BRIEF_SECTION } from "../src/agents/design-brief";
import { buildAuditFacts, factsToPromptJson } from "../src/agents/money-facts";
import { VERDICT_STAR_RANGE, type AnalystOutput } from "../src/agents/prompts/analyst";
import {
  BRIEF_SECTIONS,
  buildBuilderBriefPrompt,
  deriveKeywords,
  type CompetitorSummary,
} from "../src/agents/prompts/builder-brief";
import { resolveConfigVars } from "../src/agents/prompts/config-vars";
import { fetchCompetitors, htmlToExcerpt } from "../src/http";
import {
  aiSummaryMode,
  generateJsonSummary,
  MICROCENTS_PER_CENT,
  MODEL_OPUS,
  MODEL_SONNET,
  type ModelId,
} from "../src/lib/ai";
import { withBudget } from "../src/lib/budget";
import { forceFixtures } from "../src/lib/env";
import { RealSiteFetcher } from "../src/lib/site";
import { analystEligible, STAGE_BUDGET_MS } from "../src/orchestrator";
import { SupabaseStore } from "../src/store";

const CAP_CENTS = 800;
const MAX_LEADS = 20;
const MIN_LEADS = 12;
const RNG_SEED = 20261024;
/** Leads evaluated at once (each runs its four generations in parallel). */
const LEAD_CONCURRENCY = 2;
const JUDGE_MODEL = MODEL_SONNET;
const JUDGE_EFFORT = "low" as const;
const MODELS = [MODEL_OPUS, MODEL_SONNET] as const;
type EvalModel = (typeof MODELS)[number];
type Agent = "analyst" | "builder-brief";
const AGENTS: readonly Agent[] = ["analyst", "builder-brief"];
type CallKind = Agent | "judge-analyst" | "judge-builder-brief";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(SCRIPT_DIR, "..");
const REPORT_PATH = resolve(WORKER_DIR, "../../docs/EVAL-2026-10-24.md");

// ---------------------------------------------------------------------------
// Spend: reserve the projected cost before every paid call, settle after
// ---------------------------------------------------------------------------

/**
 * Single-call worst-case-ish priors (cents) from ai-core list prices
 * (Opus 4.8 $5/$25, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5 per M tokens) and
 * each call's max_tokens. The brief's prior includes its Haiku Design Brief.
 * The projection for a call is max(prior, the largest cost seen for it).
 */
const PRIOR_CENTS: Record<string, number> = {
  [`analyst:${MODEL_OPUS}`]: 6,
  [`analyst:${MODEL_SONNET}`]: 3,
  [`builder-brief:${MODEL_OPUS}`]: 25,
  [`builder-brief:${MODEL_SONNET}`]: 11,
  [`judge-analyst:${JUDGE_MODEL}`]: 4,
  [`judge-builder-brief:${JUDGE_MODEL}`]: 6,
};

interface SpendEntry {
  businessId: string;
  kind: CallKind;
  model: ModelId;
  /** Null = unknown (the call threw or the model is unpriced); the projection stands in for the cap. */
  microcents: number | null;
}

class Ledger {
  readonly entries: SpendEntry[] = [];
  private reserved = 0;
  private readonly maxSeen = new Map<string, number>();
  capHit = false;

  constructor(private readonly capMicro: number) {}

  projection(kind: CallKind, model: ModelId): number {
    const key = `${kind}:${model}`;
    const prior = (PRIOR_CENTS[key] ?? 25) * MICROCENTS_PER_CENT;
    return Math.max(prior, this.maxSeen.get(key) ?? 0);
  }

  /** Spend counted against the cap: known costs, plus the projection for unknown ones. */
  committed(): number {
    return this.entries.reduce(
      (sum, e) => sum + (e.microcents ?? this.projection(e.kind, e.model)),
      0,
    );
  }

  /** Known spend only (what the report prints as spend). */
  known(): number {
    return this.entries.reduce((sum, e) => sum + (e.microcents ?? 0), 0);
  }

  /** Can every call in `calls` still fit under the cap? (a lead is started only if all fit) */
  fits(calls: ReadonlyArray<[CallKind, ModelId]>): boolean {
    const need = calls.reduce((s, [k, m]) => s + this.projection(k, m), 0);
    return this.committed() + this.reserved + need <= this.capMicro;
  }

  /** Reserve one call's projection; null (and capHit) when it would cross the cap. */
  reserve(kind: CallKind, model: ModelId): number | null {
    const amount = this.projection(kind, model);
    if (this.committed() + this.reserved + amount > this.capMicro) {
      this.capHit = true;
      return null;
    }
    this.reserved += amount;
    return amount;
  }

  settle(reservation: number, entry: SpendEntry): void {
    this.reserved -= reservation;
    this.entries.push(entry);
    if (entry.microcents !== null) {
      const key = `${entry.kind}:${entry.model}`;
      this.maxSeen.set(key, Math.max(this.maxSeen.get(key) ?? 0, entry.microcents));
    }
  }
}

function cents(micro: number): string {
  return (micro / MICROCENTS_PER_CENT).toFixed(2);
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — A/B assignment per pair, drawn up front
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

const Score = z.number().int().min(1).max(5);
const AnalystScoresSchema = z.object({
  factual_grounding: Score,
  specificity: Score,
  actionability: Score,
  verdict_fit: Score,
});
const BriefScoresSchema = z.object({
  factual_grounding: Score,
  specificity: Score,
  completeness: Score,
  buildability: Score,
});
const Preferred = z.enum(["A", "B", "tie"]);
const AnalystJudgeSchema = z.object({
  a: AnalystScoresSchema,
  b: AnalystScoresSchema,
  preferred: Preferred,
  reason: z.string().min(1),
});
const BriefJudgeSchema = z.object({
  a: BriefScoresSchema,
  b: BriefScoresSchema,
  preferred: Preferred,
  reason: z.string().min(1),
});
type Scores = Record<string, number>;
interface JudgeVerdict {
  a: Scores;
  b: Scores;
  preferred: "A" | "B" | "tie";
  reason: string;
}

const CRITERIA: Record<Agent, readonly string[]> = {
  analyst: ["factual_grounding", "specificity", "actionability", "verdict_fit"],
  "builder-brief": ["factual_grounding", "specificity", "completeness", "buildability"],
};

const JUDGE_COMMON = `Grade each candidate independently. Every criterion is an integer 1-5 (5 = best). Then say which you prefer overall: "A", "B", or "tie" (tie only when they are genuinely equivalent in quality), and give ONE sentence of reason naming the decisive difference.

Judge substance, not length or polish: do not reward the longer candidate for being longer. The A/B order is random and carries no meaning.

Return STRICT JSON only, exactly this shape:
{ "a": { <criterion>: 1-5, ... }, "b": { <criterion>: 1-5, ... }, "preferred": "A" | "B" | "tie", "reason": "one sentence" }`;

const ANALYST_JUDGE_SYSTEM = `You are an impartial senior reviewer grading two candidate outputs, A and B, written for the same local business by an "Analyst": an executive verdict a salesperson reads before cold-calling the business about a website rebuild. Both candidates were given the same MEASURED FACTS. The star grade, health and sellability scores are deterministic; a candidate must explain and prioritize them, never re-score or invent numbers.

Criteria:
- factual_grounding: every claim, number and named problem is supported by the FACTS. 5 = nothing unsupported; 3 = one minor unsupported or inflated claim; 1 = invented metrics or claims that contradict the facts.
- specificity: names THIS business's actual measured problems (with their values) rather than advice that fits any business. 5 = every item tied to a measured finding; 1 = generic.
- actionability: the top-3 improvements are concrete, sensibly prioritized steps a salesperson can pitch and a developer can execute. 5 = concrete and well-ordered; 1 = vague.
- verdict_fit: the verdict sits inside the allowed band for the star grade (table given), and sales_lead_priority and one_line_verdict are consistent with the scores. 5 = squarely fits; 1 = contradicts.

${JUDGE_COMMON}`;

const BRIEF_JUDGE_SYSTEM = `You are an impartial senior web lead grading two candidate website-rebuild briefs, A and B, written for the same local business. A developer (or Claude Code) will paste the brief in and scaffold a Vite + React + Tailwind + shadcn/ui marketing site from it. Both candidates were given the same INPUTS (measured audit facts, competitors, keywords, homepage excerpt, Google Business Profile details).

The writer was required to output these twelve H2 sections, verbatim and in this order, each with real content and no placeholders:
${BRIEF_SECTIONS.map((s) => `## ${s}`).join("\n")}

Criteria:
- factual_grounding: no claim about the business that the INPUTS do not support (invented years in business, license numbers, awards, services, prices, metrics, or review quotes). Generic best-practice targets (e.g. "Lighthouse mobile > 90") are requirements, not claims, and are fine. 5 = nothing unsupported; 1 = several invented facts.
- specificity: tailored to THIS business (its measured gaps, services, city, competitors, real content) rather than a template that fits any business. 5 = clearly this business; 1 = generic.
- completeness: all twelve required sections are present under their own H2 and each carries non-generic content. 5 = all twelve, all substantive; 1 = several missing or empty.
- buildability: a developer could start building without asking questions: pages with H1s, sections and CTAs; concrete palette and type; concrete SEO / schema / conversion specs. 5 = ready to build; 1 = needs a follow-up conversation.

${JUDGE_COMMON}`;

/** The appended Haiku Design Brief block is not the model's writing — the judge never sees it. */
function stripDesignBriefBlock(markdown: string): string {
  const marker = `\n## ${DESIGN_BRIEF_SECTION}`;
  const at = markdown.lastIndexOf(marker);
  return at === -1 ? markdown : markdown.slice(0, at).trimEnd();
}

function bandTable(): string {
  return Object.entries(VERDICT_STAR_RANGE)
    .map(([verdict, [lo, hi]]) => `- ${verdict}: ${lo}-${hi}★`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

interface Lead {
  business: Business;
  audit: Audit;
}

interface GenRecord {
  businessId: string;
  agent: Agent;
  requestedModel: EvalModel;
  skipped: boolean;
  status: "completed" | "failed" | "skipped";
  modelUsed: string | null;
  error: string | null;
  microcents: number | null;
  tokensUsed: number;
  durationMs: number;
  guardrailPassed: boolean | null;
  guardrailNotes: string | null;
  /** Brief only: word count / sections of the delivered markdown. */
  wordCount?: number;
  sections?: number;
  file: string | null;
}

interface PairRecord {
  businessId: string;
  name: string;
  agent: Agent;
  /** Which model was shown as A (seeded). */
  aModel: EvalModel;
  judged: boolean;
  judgeError: string | null;
  verdict: JudgeVerdict | null;
  /** Mapped back to models. */
  opusScores: Scores | null;
  sonnetScores: Scores | null;
  preferredModel: EvalModel | "tie" | null;
}

const generations: GenRecord[] = [];
const pairs: PairRecord[] = [];

/**
 * Set on the first authentication failure: every later call would fail the
 * same way and fall back to a template, so the run stops instead of judging
 * template against template, and the docs report is left untouched.
 */
let fatal: string | null = null;
const AUTH_FAILURE = /status 401|status 403|invalid x-api-key|authentication/i;

function noteFatal(text: string | null | undefined): void {
  if (!fatal && text && AUTH_FAILURE.test(text)) fatal = text;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Supabase reads
// ---------------------------------------------------------------------------

async function resolveWorkspaceId(url: string, key: string): Promise<string> {
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: configs, error } = await db.from("workspace_config").select("workspace_id");
  if (error) throw new Error(`workspace_config: ${error.message}`);
  const fromConfig = [...new Set((configs ?? []).map((r) => (r as { workspace_id: string }).workspace_id))];
  if (fromConfig.length === 1) return fromConfig[0]!;
  const { data: workspaces, error: wErr } = await db.from("workspaces").select("id");
  if (wErr) throw new Error(`workspaces: ${wErr.message}`);
  const ids = (workspaces ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 1) return ids[0]!;
  throw new Error(
    `expected a single workspace, found workspace_config ${fromConfig.length} / workspaces ${ids.length} — not guessing`,
  );
}

function isBlocked(audit: Audit): boolean {
  return (
    audit.provisional === true ||
    (audit.score_breakdown as { health?: { blocked?: boolean } } | null)?.health?.blocked === true
  );
}

async function selectLeads(store: SupabaseStore, workspaceId: string): Promise<{ leads: Lead[]; eligible: number; businesses: number }> {
  const views = await store.listWorkspaceLeads(workspaceId);
  const byBusiness = new Map<string, Lead>();
  for (const v of views) {
    // listWorkspaceLeads resolves the display audit (pickDisplayAudit: newest completed).
    if (!v.audit || byBusiness.has(v.business.id)) continue;
    byBusiness.set(v.business.id, { business: v.business, audit: v.audit });
  }
  const eligible = [...byBusiness.values()]
    .filter(
      ({ business, audit }) =>
        audit.status === "completed" &&
        analystEligible({
          starGrade: audit.star_grade,
          sellabilityScore: audit.sellability_score,
          isChain: business.is_chain === true,
          provisional: isBlocked(audit),
        }),
    )
    .sort((x, y) => (x.business.id < y.business.id ? -1 : x.business.id > y.business.id ? 1 : 0));
  return { leads: eligible.slice(0, MAX_LEADS), eligible: eligible.length, businesses: byBusiness.size };
}

// ---------------------------------------------------------------------------
// One generation
// ---------------------------------------------------------------------------

function skippedRecord(businessId: string, agent: Agent, model: EvalModel): GenRecord {
  return {
    businessId,
    agent,
    requestedModel: model,
    skipped: true,
    status: "skipped",
    modelUsed: null,
    error: "cap",
    microcents: null,
    tokensUsed: 0,
    durationMs: 0,
    guardrailPassed: null,
    guardrailNotes: null,
    file: null,
  };
}

async function generate<T extends Record<string, unknown>>(input: {
  ledger: Ledger;
  runDir: string;
  lead: Lead;
  agent: Agent;
  model: EvalModel;
  run: (signal: AbortSignal) => Promise<AgentResult<T>>;
}): Promise<{ record: GenRecord; output: T | null }> {
  const { ledger, runDir, lead, agent, model } = input;
  const id = lead.business.id;
  const reservation = ledger.reserve(agent, model);
  if (reservation === null) return { record: skippedRecord(id, agent, model), output: null };

  const startedAt = Date.now();
  let result: AgentResult<T> | null = null;
  let thrown: string | null = null;
  try {
    // Same 120 s budget the on-demand route races these agents against.
    result = await withBudget(agent, STAGE_BUDGET_MS.analyst, input.run);
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  const microcents = result ? (result.costMicrocents ?? null) : null;
  ledger.settle(reservation, { businessId: id, kind: agent, model, microcents });
  noteFatal(thrown ?? result?.guardrailNotes ?? result?.error);

  let file: string | null = null;
  if (result?.output) {
    if (agent === "builder-brief") {
      file = `${id}.${agent}.${model}.md`;
      writeFileSync(join(runDir, file), (result.output as unknown as BuilderBriefOutput).markdown, "utf8");
    } else {
      file = `${id}.${agent}.${model}.json`;
      writeJson(join(runDir, file), result);
    }
  }
  const brief = agent === "builder-brief" && result?.output ? (result.output as unknown as BuilderBriefOutput) : null;
  const record: GenRecord = {
    businessId: id,
    agent,
    requestedModel: model,
    skipped: false,
    status: result ? (result.status === "completed" ? "completed" : "failed") : "failed",
    modelUsed: result?.modelUsed ?? null,
    error: thrown ?? result?.error ?? null,
    microcents,
    tokensUsed: result?.tokensUsed ?? 0,
    durationMs: result?.durationMs ?? Date.now() - startedAt,
    guardrailPassed: result ? result.guardrailPassed : null,
    guardrailNotes: result?.guardrailNotes ?? null,
    ...(brief ? { wordCount: brief.word_count, sections: brief.sections.length } : {}),
    file,
  };
  console.log(
    `  ${lead.business.name} · ${agent} · ${model}: ${record.status}${record.modelUsed && record.modelUsed !== model ? ` (answered by ${record.modelUsed})` : ""}${record.modelUsed === null && result ? " (template)" : ""} · ${microcents === null ? "cost unknown" : `${cents(microcents)}¢`} · ${(record.durationMs / 1000).toFixed(1)}s`,
  );
  return { record, output: result?.output ?? null };
}

// ---------------------------------------------------------------------------
// One judge call
// ---------------------------------------------------------------------------

async function judge(input: {
  ledger: Ledger;
  runDir: string;
  lead: Lead;
  agent: Agent;
  aModel: EvalModel;
  candidates: Record<EvalModel, string>;
  context: string;
}): Promise<PairRecord> {
  const { ledger, runDir, lead, agent, aModel, candidates, context } = input;
  const id = lead.business.id;
  const bModel: EvalModel = aModel === MODEL_OPUS ? MODEL_SONNET : MODEL_OPUS;
  const kind: CallKind = agent === "analyst" ? "judge-analyst" : "judge-builder-brief";
  const base: PairRecord = {
    businessId: id,
    name: lead.business.name,
    agent,
    aModel,
    judged: false,
    judgeError: null,
    verdict: null,
    opusScores: null,
    sonnetScores: null,
    preferredModel: null,
  };
  const reservation = ledger.reserve(kind, JUDGE_MODEL);
  if (reservation === null) return { ...base, judgeError: "cap" };

  const prompt = [
    context,
    "",
    "=== CANDIDATE A ===",
    candidates[aModel],
    "=== END CANDIDATE A ===",
    "",
    "=== CANDIDATE B ===",
    candidates[bModel],
    "=== END CANDIDATE B ===",
  ].join("\n");
  const failed: JudgeVerdict = { a: {}, b: {}, preferred: "tie", reason: "" };
  let outcome: Awaited<ReturnType<typeof generateJsonSummary<JudgeVerdict>>> | null = null;
  let thrown: string | null = null;
  try {
    outcome = await generateJsonSummary<JudgeVerdict>({
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
      system: agent === "analyst" ? ANALYST_JUDGE_SYSTEM : BRIEF_JUDGE_SYSTEM,
      prompt,
      maxTokens: agent === "analyst" ? 3000 : 4000,
      schema: (agent === "analyst" ? AnalystJudgeSchema : BriefJudgeSchema) as unknown as ZodType<JudgeVerdict>,
      guardrail: () => ({ passed: true, notes: null }),
      // A failed judge call is detected by modelUsed === null, never scored.
      template: () => failed,
      timeoutMs: STAGE_BUDGET_MS.analyst,
    });
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  ledger.settle(reservation, {
    businessId: id,
    kind,
    model: JUDGE_MODEL,
    microcents: outcome ? outcome.costMicrocents : null,
  });

  noteFatal(thrown ?? outcome?.guardrailNotes);
  const ok = outcome !== null && outcome.modelUsed !== null;
  const verdict = ok ? outcome!.value : null;
  const pair: PairRecord = {
    ...base,
    judged: ok,
    judgeError: ok ? null : (thrown ?? outcome?.guardrailNotes ?? "judge failed"),
    verdict,
    opusScores: verdict ? (aModel === MODEL_OPUS ? verdict.a : verdict.b) : null,
    sonnetScores: verdict ? (aModel === MODEL_SONNET ? verdict.a : verdict.b) : null,
    preferredModel: verdict
      ? verdict.preferred === "tie"
        ? "tie"
        : verdict.preferred === "A"
          ? aModel
          : bModel
      : null,
  };
  writeJson(join(runDir, `${id}.judge-${agent}.json`), {
    a_model: aModel,
    b_model: bModel,
    judge_model: JUDGE_MODEL,
    model_used: outcome?.modelUsed ?? null,
    cost_microcents: outcome?.costMicrocents ?? null,
    error: pair.judgeError,
    verdict,
  });
  console.log(
    `  ${lead.business.name} · judge ${agent}: ${ok ? `preferred ${pair.preferredModel}` : `FAILED (${pair.judgeError})`} · ${outcome?.costMicrocents == null ? "cost unknown" : `${cents(outcome.costMicrocents)}¢`}`,
  );
  return pair;
}

// ---------------------------------------------------------------------------
// One lead
// ---------------------------------------------------------------------------

const LEAD_CALLS: ReadonlyArray<[CallKind, ModelId]> = [
  ["analyst", MODEL_OPUS],
  ["analyst", MODEL_SONNET],
  ["builder-brief", MODEL_OPUS],
  ["builder-brief", MODEL_SONNET],
  ["judge-analyst", JUDGE_MODEL],
  ["judge-builder-brief", JUDGE_MODEL],
];

async function evalLead(input: {
  store: SupabaseStore;
  workspaceId: string;
  config: WorkspaceConfig | null;
  ledger: Ledger;
  runDir: string;
  lead: Lead;
  aModels: Record<Agent, EvalModel>;
}): Promise<void> {
  const { store, workspaceId, config, ledger, runDir, lead, aModels } = input;
  const { business, audit } = lead;
  if (!ledger.fits(LEAD_CALLS)) {
    ledger.capHit = true;
    console.log(`  ${business.name}: skipped — the lead's projected cost would cross the cap`);
    for (const agent of AGENTS) for (const m of MODELS) generations.push(skippedRecord(business.id, agent, m));
    return;
  }

  // Exactly the on-demand Builder Brief route's inputs (src/http.ts).
  const competitors: CompetitorSummary[] = await fetchCompetitors(store, workspaceId, business.id, business.category);
  let siteHtmlExcerpt: string | null = null;
  if (business.website_url) {
    try {
      const site = await new RealSiteFetcher().fetchHomepage(business.website_url);
      if (site) siteHtmlExcerpt = htmlToExcerpt(site.html);
    } catch {
      siteHtmlExcerpt = null;
    }
  }

  const analyst = (model: EvalModel) =>
    generate<AnalystOutput>({
      ledger,
      runDir,
      lead,
      agent: "analyst",
      model,
      run: (signal) => runAnalyst({ business, audit, config, model, signal }),
    });
  const brief = (model: EvalModel) =>
    generate<BuilderBriefOutput>({
      ledger,
      runDir,
      lead,
      agent: "builder-brief",
      model,
      run: (signal) =>
        runBuilderBrief({ business, audit, config, competitors, siteHtmlExcerpt, signal, force: true, model }),
    });
  const [aOpus, aSonnet, bOpus, bSonnet] = await Promise.all([
    analyst(MODEL_OPUS),
    analyst(MODEL_SONNET),
    brief(MODEL_OPUS),
    brief(MODEL_SONNET),
  ]);
  generations.push(aOpus.record, aSonnet.record, bOpus.record, bSonnet.record);
  if (fatal) return;

  const facts = buildAuditFacts(business, audit);
  const vars = resolveConfigVars(config);
  const judges: Promise<PairRecord>[] = [];
  if (aOpus.output && aSonnet.output) {
    const context = [
      `Business: ${business.name}`,
      `Star grade (deterministic, 1-5): ${facts.scores.star_grade ?? "unknown"}`,
      `Health score (0-100): ${facts.scores.health_score ?? "unknown"}`,
      `Sellability score (0-100): ${facts.scores.sellability_score ?? "unknown"}`,
      "Allowed verdicts by star grade:",
      bandTable(),
      "",
      "FACTS — measured audit data (JSON):",
      factsToPromptJson(facts),
    ].join("\n");
    judges.push(
      judge({
        ledger,
        runDir,
        lead,
        agent: "analyst",
        aModel: aModels.analyst,
        candidates: {
          [MODEL_OPUS]: JSON.stringify(aOpus.output, null, 2),
          [MODEL_SONNET]: JSON.stringify(aSonnet.output, null, 2),
        } as Record<EvalModel, string>,
        context,
      }),
    );
  } else {
    pairs.push(unjudged(lead, "analyst", aModels.analyst, "a candidate has no output"));
  }
  if (bOpus.output && bSonnet.output) {
    // The writer's own inputs: the AuditFacts plus competitors, keywords,
    // homepage excerpt and GBP details, so grounding is checked against
    // everything the writer was allowed to use.
    const context = [
      "INPUTS the writer was given:",
      buildBuilderBriefPrompt(
        facts,
        vars,
        competitors,
        deriveKeywords(facts),
        siteHtmlExcerpt,
        briefBusinessInputsOf(business, audit),
      ),
    ].join("\n");
    judges.push(
      judge({
        ledger,
        runDir,
        lead,
        agent: "builder-brief",
        aModel: aModels["builder-brief"],
        candidates: {
          [MODEL_OPUS]: stripDesignBriefBlock(bOpus.output.markdown),
          [MODEL_SONNET]: stripDesignBriefBlock(bSonnet.output.markdown),
        } as Record<EvalModel, string>,
        context,
      }),
    );
  } else {
    pairs.push(unjudged(lead, "builder-brief", aModels["builder-brief"], "a candidate has no output"));
  }
  pairs.push(...(await Promise.all(judges)));
}

function unjudged(lead: Lead, agent: Agent, aModel: EvalModel, why: string): PairRecord {
  return {
    businessId: lead.business.id,
    name: lead.business.name,
    agent,
    aModel,
    judged: false,
    judgeError: why,
    verdict: null,
    opusScores: null,
    sonnetScores: null,
    preferredModel: null,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SHORT: Record<EvalModel, string> = {
  [MODEL_OPUS]: "Opus 4.8",
  [MODEL_SONNET]: "Sonnet 5.5",
};

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function fmt(v: number | null, digits = 2): string {
  return v === null ? "—" : v.toFixed(digits);
}

function total(scores: Scores | null): number {
  return scores ? Object.values(scores).reduce((s, v) => s + v, 0) : 0;
}

interface AgentStats {
  judged: PairRecord[];
  opusWins: number;
  sonnetWins: number;
  ties: number;
  means: Record<EvalModel, Record<string, number | null>>;
  sonnetWinOrTie: number | null;
  recommendation: "keep Opus" | "move to Sonnet" | "inconclusive";
  why: string;
}

function agentStats(agent: Agent): AgentStats {
  const judged = pairs.filter((p) => p.agent === agent && p.judged);
  const opusWins = judged.filter((p) => p.preferredModel === MODEL_OPUS).length;
  const sonnetWins = judged.filter((p) => p.preferredModel === MODEL_SONNET).length;
  const ties = judged.filter((p) => p.preferredModel === "tie").length;
  const means = {} as Record<EvalModel, Record<string, number | null>>;
  for (const model of MODELS) {
    means[model] = {};
    for (const c of CRITERIA[agent]) {
      means[model][c] = mean(
        judged.map((p) => (model === MODEL_OPUS ? p.opusScores : p.sonnetScores)?.[c] ?? NaN).filter((v) => !Number.isNaN(v)),
      );
    }
  }
  const n = judged.length;
  const sonnetWinOrTie = n === 0 ? null : (sonnetWins + ties) / n;
  const fgOpus = means[MODEL_OPUS].factual_grounding ?? null;
  const fgSonnet = means[MODEL_SONNET].factual_grounding ?? null;
  let recommendation: AgentStats["recommendation"];
  let why: string;
  if (n < MIN_LEADS || fgOpus === null || fgSonnet === null || sonnetWinOrTie === null) {
    recommendation = "inconclusive";
    why = `only ${n} judged pair(s) — below the ${MIN_LEADS}-pair minimum the brief sets for a decision.`;
  } else {
    const winOk = sonnetWinOrTie >= 0.7;
    const fgOk = fgSonnet >= fgOpus - 0.3 - 1e-9; // means of integers: 3.15 vs 3.45 is exactly 0.3
    recommendation = winOk && fgOk ? "move to Sonnet" : "keep Opus";
    why =
      `Sonnet won or tied ${sonnetWins + ties}/${n} pairs (${(sonnetWinOrTie * 100).toFixed(0)}% — ${winOk ? "meets" : "below"} the 70% bar); ` +
      `factual_grounding Sonnet ${fgSonnet.toFixed(2)} vs Opus ${fgOpus.toFixed(2)} ` +
      `(${fgOk ? "meets" : "fails"} Sonnet ≥ Opus − 0.3).`;
  }
  return { judged, opusWins, sonnetWins, ties, means, sonnetWinOrTie, recommendation, why };
}

function writeReport(input: {
  workspaceId: string;
  runDir: string;
  leads: Lead[];
  eligible: number;
  businesses: number;
  ledger: Ledger;
  startedAt: Date;
  aModelsByLead: Map<string, Record<Agent, EvalModel>>;
}): void {
  const { workspaceId, runDir, leads, eligible, businesses, ledger, startedAt } = input;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const stats: Record<Agent, AgentStats> = {
    analyst: agentStats("analyst"),
    "builder-brief": agentStats("builder-brief"),
  };
  const evaluated = new Set(generations.filter((g) => !g.skipped).map((g) => g.businessId));

  push(
    "# EVAL 2026-10-24 — Analyst + Builder Brief: Opus 4.8 vs Sonnet 5.5 (RFL.EVAL.5)",
    "",
    `Run ${startedAt.toISOString()} · script \`apps/worker/scripts/eval-analyst-brief.ts\` · raw outputs \`apps/worker/.eval/${runDir.split(/[\\/]/).pop()}/\` (gitignored) · workspace \`${workspaceId}\``,
    "",
    "Blind pairwise eval. Each lead's Analyst and Builder Brief were generated on both models with identical inputs; a Sonnet 5.5 judge (effort low, strict JSON) scored each pair with the model names hidden and the A/B order drawn from a seeded RNG (mulberry32, seed " +
      `${RNG_SEED}). The production model constants are unchanged; this is a recommendation for the architect.`,
    "",
    "## Leads",
    "",
    `Selection (deterministic): every business in the workspace whose display audit (newest completed, \`pickDisplayAudit\` via \`listWorkspaceLeads\`) passes the production Analyst gate \`analystEligible\` (star ≤ 3, sellability ≥ 60, not a chain, not provisional/bot-blocked), sorted by business id, first ${MAX_LEADS}. ` +
      `${eligible} of ${businesses} businesses with an audit qualified; ${leads.length} selected; ${evaluated.size} evaluated before the run ended${ledger.capHit ? " (stopped at the $8.00 cap)" : ""}.`,
    "",
    "| # | Business | ★ | Sellability | Health | Business id |",
    "|---|---|---|---|---|---|",
    ...leads.map(
      (l, i) =>
        `| ${i + 1} | ${l.business.name} | ${l.audit.star_grade ?? "—"} | ${l.audit.sellability_score ?? "—"} | ${l.audit.website_health_score ?? "—"} | \`${l.business.id}\` |`,
    ),
    "",
    "## Spend",
    "",
    `Total known spend **$${(ledger.known() / MICROCENTS_PER_CENT / 100).toFixed(2)}** of the $${(CAP_CENTS / 100).toFixed(2)} cap. Builder Brief cost includes its embedded Design Brief call (Haiku 4.5, regenerated per run because the eval passes force: true).`,
    "",
    "| Call | Model | Calls | Total ¢ | Mean ¢/call | Unknown-cost calls |",
    "|---|---|---|---|---|---|",
  );
  const kinds: CallKind[] = ["analyst", "builder-brief", "judge-analyst", "judge-builder-brief"];
  for (const kind of kinds) {
    for (const model of kind.startsWith("judge") ? [JUDGE_MODEL] : MODELS) {
      const es = ledger.entries.filter((e) => e.kind === kind && e.model === model);
      if (es.length === 0) continue;
      const known = es.filter((e) => e.microcents !== null).map((e) => e.microcents!);
      const sum = known.reduce((s, v) => s + v, 0);
      push(
        `| ${kind} | ${model} | ${es.length} | ${cents(sum)} | ${known.length ? cents(sum / known.length) : "—"} | ${es.length - known.length} |`,
      );
    }
  }

  push("", "## Generation health", "", "| Agent | Model | Runs | Model answered | Template fallback | Refusal → Opus | Guardrail flagged | Failed/truncated | Mean s | Mean tokens | Brief words / sections |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const agent of AGENTS) {
    for (const model of MODELS) {
      const gs = generations.filter((g) => g.agent === agent && g.requestedModel === model && !g.skipped);
      if (gs.length === 0) continue;
      const answered = gs.filter((g) => g.modelUsed === model).length;
      const template = gs.filter((g) => g.modelUsed === null).length;
      const refusal = gs.filter((g) => g.modelUsed !== null && g.modelUsed !== model).length;
      const flagged = gs.filter((g) => g.guardrailPassed === false && g.modelUsed !== null).length;
      const failed = gs.filter((g) => g.status === "failed").length;
      const words = mean(gs.filter((g) => g.wordCount !== undefined).map((g) => g.wordCount!));
      const secs = mean(gs.filter((g) => g.sections !== undefined).map((g) => g.sections!));
      push(
        `| ${agent} | ${SHORT[model]} | ${gs.length} | ${answered} | ${template} | ${refusal} | ${flagged} | ${failed} | ${fmt(mean(gs.map((g) => g.durationMs / 1000)), 1)} | ${fmt(mean(gs.map((g) => g.tokensUsed)), 0)} | ${agent === "builder-brief" ? `${fmt(words, 0)} / ${fmt(secs, 1)}` : "—"} |`,
      );
    }
  }

  push("", "## Scores", "");
  for (const agent of AGENTS) {
    const s = stats[agent];
    const unjudgedCount = pairs.filter((p) => p.agent === agent && !p.judged).length;
    push(
      `### ${agent === "analyst" ? "Analyst" : "Builder Brief"} — ${s.judged.length} judged pair(s)${unjudgedCount ? `, ${unjudgedCount} not judged` : ""}`,
      "",
      "| Criterion | Opus 4.8 mean | Sonnet 5.5 mean | Δ (Sonnet − Opus) |",
      "|---|---|---|---|",
      ...CRITERIA[agent].map((c) => {
        const o = s.means[MODEL_OPUS][c] ?? null;
        const n = s.means[MODEL_SONNET][c] ?? null;
        return `| ${c} | ${fmt(o)} | ${fmt(n)} | ${o !== null && n !== null ? (n - o >= 0 ? "+" : "") + (n - o).toFixed(2) : "—"} |`;
      }),
      "",
      "| Preferred | Count |",
      "|---|---|",
      `| Opus 4.8 | ${s.opusWins} |`,
      `| Sonnet 5.5 | ${s.sonnetWins} |`,
      `| tie | ${s.ties} |`,
      "",
    );
  }

  const gaps = pairs
    .filter((p) => p.judged)
    .map((p) => ({ p, gap: total(p.opusScores) - total(p.sonnetScores) }))
    .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap) || (x.p.businessId < y.p.businessId ? -1 : 1))
    .slice(0, 3);
  push("## Three largest score gaps", "", "Gap = Opus total − Sonnet total over the four criteria (max 20 each).", "");
  for (const { p, gap } of gaps) {
    const crit = CRITERIA[p.agent]
      .map((c) => `${c} ${p.opusScores?.[c] ?? "—"}/${p.sonnetScores?.[c] ?? "—"}`)
      .join(", ");
    push(
      `- **${p.name}** · ${p.agent} · Opus ${total(p.opusScores)} vs Sonnet ${total(p.sonnetScores)} (gap ${gap > 0 ? "+" : ""}${gap}; per criterion Opus/Sonnet: ${crit}) · preferred **${p.preferredModel === "tie" ? "tie" : SHORT[p.preferredModel as EvalModel]}** — judge: “${p.verdict?.reason ?? ""}”`,
    );
  }

  const unjudgedPairs = pairs.filter((p) => !p.judged);
  if (unjudgedPairs.length > 0) {
    push("", "## Pairs not judged", "", ...unjudgedPairs.map((p) => `- ${p.name} · ${p.agent}: ${p.judgeError}`));
  }

  push(
    "",
    "## RECOMMENDATION",
    "",
    `Rule (from the brief): move an agent to Sonnet 5.5 only if Sonnet wins or ties ≥ 70% of judged pairs AND its factual_grounding mean is within 0.3 of Opus (not more than 0.3 below). Fewer than ${MIN_LEADS} judged pairs → inconclusive.`,
    "",
    `- **Analyst: ${stats.analyst.recommendation}** — ${stats.analyst.why}`,
    `- **Builder Brief: ${stats["builder-brief"].recommendation}** — ${stats["builder-brief"].why}`,
    "",
    "Caveats: one judge model (Sonnet 5.5, the same model as one candidate — self-preference cannot be ruled out, though names were hidden and order randomized); one sample per model per lead; effort \"low\" on every call, as in production.",
    "",
  );
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
  writeJson(join(runDir, "run.json"), {
    workspaceId,
    seed: RNG_SEED,
    capCents: CAP_CENTS,
    capHit: ledger.capHit,
    knownSpendMicrocents: ledger.known(),
    leads: leads.map((l) => ({ id: l.business.id, name: l.business.name, star: l.audit.star_grade, sellability: l.audit.sellability_score, auditId: l.audit.id })),
    abMapping: Object.fromEntries(input.aModelsByLead),
    spend: ledger.entries,
    generations,
    pairs,
    recommendation: { analyst: stats.analyst.recommendation, "builder-brief": stats["builder-brief"].recommendation },
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — this script reads the live project and needs the worker env.");
  }
  if (!dryRun && (forceFixtures() || aiSummaryMode() !== "core")) {
    throw new Error("AI is in template mode (RAPIDFORGE_FORCE_FIXTURES set or no ANTHROPIC_API_KEY) — the eval needs real model calls.");
  }

  const workspaceId = await resolveWorkspaceId(url, key);
  const store = new SupabaseStore(url, key);
  const { leads, eligible, businesses } = await selectLeads(store, workspaceId);
  console.log(`workspace: ${workspaceId}`);
  console.log(`analyst-eligible: ${eligible} of ${businesses} businesses with an audit; selected ${leads.length}`);
  leads.forEach((l, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${l.business.name} — ${l.audit.star_grade}★ · sellability ${l.audit.sellability_score} · ${l.business.id}`),
  );
  if (leads.length < MIN_LEADS) {
    console.error(`Only ${leads.length} leads qualify (< ${MIN_LEADS}) — stopping without any paid call; the rules are not loosened.`);
    process.exitCode = 2;
    return;
  }
  if (dryRun) return;

  const config = await store.getWorkspaceConfig(workspaceId);
  const startedAt = new Date();
  const runDir = join(WORKER_DIR, ".eval", startedAt.toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });

  // A/B per pair, drawn once in lead order so the mapping never depends on timing.
  const rng = mulberry32(RNG_SEED);
  const aModelsByLead = new Map<string, Record<Agent, EvalModel>>();
  for (const l of leads) {
    aModelsByLead.set(l.business.id, {
      analyst: rng() < 0.5 ? MODEL_OPUS : MODEL_SONNET,
      "builder-brief": rng() < 0.5 ? MODEL_OPUS : MODEL_SONNET,
    });
  }
  writeJson(join(runDir, "ab-mapping.json"), Object.fromEntries(aModelsByLead));

  const ledger = new Ledger(CAP_CENTS * MICROCENTS_PER_CENT);
  let next = 0;
  const worker = async () => {
    while (next < leads.length && !fatal) {
      const lead = leads[next++]!;
      console.log(`[${leads.indexOf(lead) + 1}/${leads.length}] ${lead.business.name} · spent ${cents(ledger.known())}¢`);
      await evalLead({ store, workspaceId, config, ledger, runDir, lead, aModels: aModelsByLead.get(lead.business.id)! });
    }
  };
  await Promise.all(Array.from({ length: LEAD_CONCURRENCY }, worker));
  if (fatal) {
    writeJson(join(runDir, "run.json"), { workspaceId, aborted: fatal, spend: ledger.entries, generations, pairs });
    throw new Error(`Aborted on an authentication failure (spent ${cents(ledger.known())}¢; docs report not written): ${fatal}`);
  }

  writeReport({ workspaceId, runDir, leads, eligible, businesses, ledger, startedAt, aModelsByLead });
  console.log(`spent ${cents(ledger.known())}¢${ledger.capHit ? " (cap reached)" : ""} · report ${REPORT_PATH} · raw ${runDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
