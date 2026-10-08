/**
 * Orchestrator — owns the pipeline described in PRD 3.3.
 *
 * Sprint 2 flow:
 *   1. POST /api/searches → `searches` row + 'scout' job in `jobs`.
 *   2. Scout job → runScout → N businesses upserted → fan out one
 *      'audit_business' job per business.
 *   3. 'audit_business' → Filter gate + special routing (CLAUDE.md 6.7):
 *      no-website/social-only → sellability-95 hot lead (never skipped,
 *      never audited); dead site → health 10; live site → provisional
 *      'pending' audit row awaiting the Sprint 3 audit agents.
 *   4. Sprint 3 adds Health/Conversion/Presence/Traffic + Scorer to the
 *      audit_business fan-out. Sprint 4 makes events real Realtime.
 *
 * Every agent run writes an `agent_runs` row and emits AgentEvents
 * (CLAUDE.md 6.5) — done here so agents stay pure.
 */
import type { AgentResult, Business, Job, Search } from "@rapidforge/shared";
import { runAnalyst } from "./agents/analyst";
import { runConversion } from "./agents/conversion";
import { runDesign } from "./agents/design";
import { planBlockedOutcome, runFilter } from "./agents/filter";
import { runHealth } from "./agents/health";
import { runPresence } from "./agents/presence";
import { runReputation } from "./agents/reputation";
import { runScorer } from "./agents/scorer";
import { runScout } from "./agents/scout";
import { runSeo } from "./agents/seo";
import { runTraffic } from "./agents/traffic";
import { broadcastAgentEvent } from "./events";
import {
  budgetedStage,
  StageAbortedError,
  isStageTimeout,
  stageLogger,
  withBudget,
  type StageLogger,
} from "./lib/budget";
import { centsFromMicrocents, sumMicrocents } from "./lib/ai";
import { detectBotProtection } from "./lib/bot-protection";
import { BrowserUnavailableError } from "./lib/browser";
import type { PlacesClient } from "./lib/places";
import type { WebProbe } from "./lib/probe";
import type { PsiClient, PsiStrategy } from "./lib/psi";
import {
  screenshotSlug,
  type ScreenshotCapturer,
  type ScreenshotSet,
  type ScreenshotStorage,
  type ScreenshotUrls,
} from "./lib/screenshots";
import type { SiteFetcher } from "./lib/site";
import type { DataStore } from "./store";

/** Hard cap on concurrent business audits (CLAUDE.md Section 8). */
export const AUDIT_CONCURRENCY_CAP = 5;

/**
 * Per-stage budgets (RFL.QUEUE.8). A stage that overruns is abandoned: the
 * audit continues with that stage's neutral value (PSI → unmeasured,
 * screenshot → none, agent → failed run) and records a low
 * "<stage> timed out" issue — except screenshots, which stay in
 * score_breakdown.stage_timeouts (RFL.VERIFY.3 V2). Only probe / homepage
 * fetch overruns fail the audit. The whole audit has a hard ceiling; the
 * queue abandons the job at ceiling + 30s if even that does not return.
 */
export const STAGE_BUDGET_MS = {
  probe: 15_000,
  fetch: 15_000,
  psi: 45_000,
  screenshot: 30_000,
  agent: 60_000,
  analyst: 120_000,
} as const;
export const AUDIT_CEILING_MS = 4 * 60_000;

/** Desktop PSI is off by default (one PSI call per audit, finding 12 cost). */
export function psiDesktopEnabled(): boolean {
  return process.env.PSI_DESKTOP === "true";
}

/** Per-job options the queue passes down. */
export interface HandleJobOptions {
  /** Aborted by the queue when the job is abandoned past the ceiling. */
  signal?: AbortSignal;
}

/** Analyst auto-run threshold (CLAUDE.md Section 8) — used from Sprint 7. */
export const ANALYST_SELLABILITY_THRESHOLD = 60;
/** PRD 4.2: 4–5★ sites are not sales targets — the Analyst skips them. */
export const ANALYST_MAX_STAR_GRADE = 3;

/**
 * The Analyst auto-run gate (RFL-05, audit finding 2): star ≤ 3 AND
 * sellability ≥ 60 AND not a chain AND not a provisional (bot-blocked)
 * audit. Pure, so the four conditions are unit-tested directly.
 */
export function analystEligible(input: {
  starGrade: number | null;
  sellabilityScore: number | null;
  isChain: boolean;
  provisional: boolean;
}): boolean {
  return (
    input.starGrade !== null &&
    input.starGrade <= ANALYST_MAX_STAR_GRADE &&
    input.sellabilityScore !== null &&
    input.sellabilityScore >= ANALYST_SELLABILITY_THRESHOLD &&
    !input.isChain &&
    !input.provisional
  );
}

/**
 * 30-day audit cache (PRD 5.5). Freshness is keyed on the audit's own
 * completed_at rather than businesses.last_refreshed_at, because Scout
 * bumps last_refreshed_at on every search — it measures discovery
 * recency, not audit recency.
 */
export const AUDIT_CACHE_DAYS = 30;

export interface OrchestratorDeps {
  store: DataStore;
  places: PlacesClient;
  probe: WebProbe;
  psi: PsiClient;
  site: SiteFetcher;
  /** Sprint 6: homepage screenshot capture + storage (PRD 6.8 inputs). */
  screenshotCapturer: ScreenshotCapturer;
  screenshotStorage: ScreenshotStorage;
}

/** jobs.payload shape for 'scout' and 'audit_business' jobs. */
export interface JobPayload {
  search_id?: string;
  business_id?: string;
  /** Re-audit's cache bypass (PRD 5.5 "Force re-audit") — Sprint 5. */
  force?: boolean;
}

export function payloadOf(job: Job): JobPayload {
  return job.payload as JobPayload;
}

/** Dispatch a claimed job. Throws on failure — the queue owns retries. */
export async function handleJob(
  job: Job,
  deps: OrchestratorDeps,
  opts: HandleJobOptions = {},
): Promise<void> {
  switch (job.job_type) {
    case "scout":
      return handleScoutJob(job, deps);
    case "audit_business":
      // Whole-audit ceiling: a job never stays 'running' past this.
      return withBudget(
        "audit",
        AUDIT_CEILING_MS,
        (signal) => handleAuditBusinessJob(job, deps, signal),
        opts.signal,
      );
    default:
      throw new Error(
        `[orchestrator] job_type '${job.job_type}' not implemented until Sprint 3+`,
      );
  }
}

async function handleScoutJob(job: Job, deps: OrchestratorDeps): Promise<void> {
  const { store } = deps;
  const searchId = payloadOf(job).search_id;
  if (!searchId) throw new Error("scout job payload missing search_id");
  const search = await store.getSearch(searchId);
  if (!search) throw new Error(`search ${searchId} not found`);

  await store.updateSearch(search.id, { status: "scouting" });

  const result = await withAgentRun(
    deps,
    { job, search, agent: "scout", targetId: null },
    () => runScout({ store, places: deps.places, search, jobId: job.id }),
  );
  if (result.status === "failed" || !result.output) {
    throw new Error(result.error ?? "scout failed");
  }

  // Fan out one audit job per business (PRD 3.3 step 2).
  for (const businessId of result.output.business_ids) {
    await store.enqueueJob({
      workspace_id: search.workspace_id,
      job_type: "audit_business",
      payload: { search_id: search.id, business_id: businessId },
    });
  }

  if (result.output.business_ids.length === 0) {
    await store.updateSearch(search.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  } else {
    await store.updateSearch(search.id, { status: "auditing" });
  }
}

/** Short reason from a capture failure (score_breakdown.screenshot_unavailable only). */
function unavailableReason(err: unknown): string {
  if (err instanceof BrowserUnavailableError) return err.reason;
  const line = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "capture failed";
}

function isWithinDays(iso: string, days: number, now: Date): boolean {
  const age = now.getTime() - Date.parse(iso);
  return Number.isFinite(age) && age >= 0 && age <= days * 86_400_000;
}

async function handleAuditBusinessJob(
  job: Job,
  deps: OrchestratorDeps,
  signal?: AbortSignal,
): Promise<void> {
  const { store } = deps;
  const { search_id: searchId, business_id: businessId, force } = payloadOf(job);
  if (!searchId || !businessId) {
    throw new Error("audit_business job payload missing search_id/business_id");
  }
  const [search, business] = await Promise.all([
    store.getSearch(searchId),
    store.getBusiness(businessId),
  ]);
  if (!search) throw new Error(`search ${searchId} not found`);
  if (!business) throw new Error(`business ${businessId} not found`);

  // Latest completed audit serves two masters: the 30-day cache (PRD 5.5,
  // ignored when force=true — Sprint 5 re-audit) and the Reputation agent's
  // review-velocity baseline (Sprint 6, used in BOTH cases). A provisional
  // (bot-blocked) audit is never a cache hit: the site is re-probed.
  const now = new Date();
  const latest = await store.getLatestCompletedAuditForBusiness(business.id);
  const cachedAudit =
    force !== true &&
    latest?.provisional !== true &&
    latest?.completed_at != null &&
    isWithinDays(latest.completed_at, AUDIT_CACHE_DAYS, now)
      ? latest
      : null;

  const result = await withAgentRun(
    deps,
    { job, search, agent: "filter", targetId: business.id },
    () =>
      runFilter({
        store,
        probe: deps.probe,
        places: deps.places,
        search,
        business,
        jobId: job.id,
        cachedAudit,
        probeBudgetMs: STAGE_BUDGET_MS.probe,
        signal,
      }),
    { budgetMs: STAGE_BUDGET_MS.agent + STAGE_BUDGET_MS.probe, signal },
  );
  if (result.status === "failed" || !result.output) {
    throw new Error(result.error ?? "filter failed");
  }

  // Only live real sites proceed to the audit agents (PRD 3.3 steps 4–5).
  // Hot leads / dead sites / skips / cache hits are complete after Filter.
  if (result.output.outcome !== "pending_audit") return;
  // Filter may have just persisted places_details (RFL-06): the agents
  // (Presence hours, Reputation review text) read the enriched row.
  const enriched = result.output.details_fetched
    ? ((await store.getBusiness(business.id)) ?? business)
    : business;
  await runAuditPipeline(
    job,
    search,
    enriched,
    result.output.audit_id,
    latest,
    deps,
    signal,
  );
}

/**
 * PRD 3.3 steps 4–5 (+ Sprint 6): Health / Conversion / Presence / Traffic /
 * Design / Reputation / SEO in parallel on shared measured inputs (ONE
 * homepage fetch, ONE mobile+desktop PSI pair, ONE screenshot capture, ONE
 * sitemap/robots probe pair), then the deterministic Scorer finalizes the
 * audit row and `lead.scored` fires.
 *
 * A single failed audit agent does NOT fail the job: its agent_runs row
 * records the failure and Scorer treats the missing fields as unmeasured.
 */
async function runAuditPipeline(
  job: Job,
  search: Search,
  business: Business,
  auditId: string,
  previousAudit: Awaited<
    ReturnType<DataStore["getLatestCompletedAuditForBusiness"]>
  >,
  deps: OrchestratorDeps,
  signal?: AbortSignal,
): Promise<void> {
  const { store } = deps;
  const url = business.website_url ?? "";
  const now = new Date();
  const log = stageLogger(job.id, business.id);
  /** Stages that overran their budget — Scorer records one low issue each. */
  const timedOut: string[] = [];

  const runPsiLogged = async (strategy: PsiStrategy) => {
    const metrics = await budgetedStage({
      log,
      stage: `psi-${strategy}`,
      budgetMs: STAGE_BUDGET_MS.psi,
      run: () => deps.psi.run(url, strategy),
      fallback: null,
      timedOut,
      signal,
    });
    await store.logUsageEvent({
      workspace_id: search.workspace_id,
      event_type: "pagespeed_call",
      cost_cents: 0, // PSI is free tier (PRD 3.5)
      metadata: { url, strategy, mode: deps.psi.mode, ok: metrics !== null },
    });
    return metrics;
  };
  // Homepage fetch is the one shared input every page agent needs: an
  // overrun here fails the audit (the job retries once, then fails).
  const fetchStage = async () => {
    const t0 = log.start("fetch");
    try {
      const site = await withBudget("fetch", STAGE_BUDGET_MS.fetch, () =>
        deps.site.fetchHomepage(url), signal);
      log.end("fetch", t0);
      return site;
    } catch (err) {
      log.end("fetch", t0, isStageTimeout(err) ? "TIMEOUT" : "ERROR");
      throw err;
    }
  };
  const pathStage = (path: string) =>
    budgetedStage({
      log,
      stage: `path${path}`,
      budgetMs: STAGE_BUDGET_MS.fetch,
      run: () => deps.site.checkPath(url, path),
      fallback: null,
      timedOut,
      signal,
    });
  // RFL.QUEUE.8a: screenshots are opt-in (SCREENSHOTS_ENABLED) — disabled
  // means no stage at all, so no browser work. A capture that fails (not a
  // stage overrun) is logged by the stage's ERROR line and its reason kept
  // in score_breakdown — never an issue (RFL.VERIFY.3 V2).
  let screenshotUnavailable: string | null = null;
  const screenshotStage = async (): Promise<ScreenshotSet | null> => {
    if (deps.screenshotCapturer.mode === "disabled") {
      console.log(`${log.prefix} stage=screenshot skipped (disabled)`);
      return null;
    }
    return budgetedStage({
      log,
      stage: "screenshot",
      budgetMs: STAGE_BUDGET_MS.screenshot,
      run: async (stageSignal) => {
        try {
          return await deps.screenshotCapturer.capture(url);
        } catch (err) {
          if (!stageSignal.aborted) screenshotUnavailable = unavailableReason(err);
          throw err;
        }
      },
      fallback: null,
      timedOut,
      signal,
    });
  };
  const [site, psiMobile, psiDesktopRun, screenshots, hasSitemap, hasRobots] =
    await Promise.all([
      fetchStage(),
      runPsiLogged("mobile"),
      psiDesktopEnabled() ? runPsiLogged("desktop") : Promise.resolve(null),
      screenshotStage(),
      pathStage("/sitemap.xml"),
      pathStage("/robots.txt"),
    ]);
  // Desktop PSI is opt-in (PSI_DESKTOP=true): without it the desktop term
  // reuses the MEASURED mobile run rather than an invented neutral — mobile
  // is the stricter of the two, so health is never overstated.
  const psiDesktop = psiDesktopRun ?? psiMobile;
  // Health narrates "desktop not measured" when the copy is in play (RFL.FIX.3e).
  const desktopMeasured = psiDesktopRun !== null;
  // The probe passed but the homepage fetch hit bot protection (finding 4):
  // never analyse a challenge page — no agents, no screenshots of the block
  // page. Finalize as blocked: one low issue, neutral provisional scores.
  const siteBlock = site
    ? detectBotProtection({
        status: site.httpStatus,
        headers: site.headers,
        body: site.html,
      })
    : null;
  if (site && siteBlock) {
    const plan = planBlockedOutcome(business, {
      note: siteBlock.note,
      blockedBy: siteBlock.reason,
    });
    await store.updateAudit(auditId, {
      http_status: site.httpStatus,
      response_ms: site.responseMs,
      website_health_score: plan.health,
      star_grade: plan.star,
      sellability_score: plan.sellability,
      score_breakdown: plan.breakdown,
      issues: plan.issues,
      status: plan.auditStatus,
      completed_at: now.toISOString(),
      provisional: true,
    });
    // RFL.WEB.10: the pointer follows the audit that just finalized.
    await store.setLatestAudit(search.id, business.id, auditId);
    console.warn(
      `[orchestrator] business ${business.id} blocked on homepage fetch (${siteBlock.reason}) — audit ${auditId} provisional`,
    );
    await broadcastAgentEvent(search.workspace_id, {
      type: "lead.scored",
      businessId: business.id,
      healthScore: plan.health ?? 0,
      sellabilityScore: plan.sellability ?? 0,
    });
    return;
  }

  // Store before the agent fan-out so the drawer's Screenshots tab has URLs
  // even if a later agent fails. Null anywhere = screenshots stay null.
  const screenshotUrls: ScreenshotUrls | null = screenshots
    ? await deps.screenshotStorage.store(
        business.id,
        auditId,
        screenshots,
        screenshotSlug(url),
      )
    : null;

  const runCtx = { job, search, budgetMs: STAGE_BUDGET_MS.agent, signal, log };
  const [health, conversion, presence, traffic, design, reputation, seo] =
    await Promise.all([
      withAgentRun(deps, { ...runCtx, agent: "health", targetId: business.id }, (signal) =>
        runHealth({ business, site, psiDesktop, psiMobile, desktopMeasured, now, signal }),
      ),
      withAgentRun(
        deps,
        { ...runCtx, agent: "conversion", targetId: business.id },
        (signal) => runConversion({ business, site, signal }),
      ),
      withAgentRun(
        deps,
        { ...runCtx, agent: "presence", targetId: business.id },
        (signal) => runPresence({ business, site, signal }),
      ),
      withAgentRun(
        deps,
        { ...runCtx, agent: "traffic", targetId: business.id },
        () => runTraffic({ psiDesktop, psiMobile }),
      ),
      withAgentRun(
        deps,
        { ...runCtx, agent: "design", targetId: business.id },
        (signal) => runDesign({ business, site, screenshots, now, signal }),
      ),
      withAgentRun(
        deps,
        { ...runCtx, agent: "reputation", targetId: business.id },
        (signal) => runReputation({ business, previousAudit, now, signal }),
      ),
      withAgentRun(deps, { ...runCtx, agent: "seo", targetId: business.id }, (signal) =>
        runSeo({ business, site, hasSitemap, hasRobots, signal }),
      ),
    ]);

  const scorer = await withAgentRun(
    deps,
    { ...runCtx, agent: "scorer", targetId: business.id },
    () =>
      runScorer({
        store,
        business,
        auditId,
        health: health.output,
        conversion: conversion.output,
        presence: presence.output,
        traffic: traffic.output,
        design: design.output,
        reputation: reputation.output,
        seo: seo.output,
        screenshotUrls,
        now,
        stageTimeouts: [
          ...timedOut,
          ...[health, conversion, presence, traffic, design, reputation, seo]
            .filter((r) => r.status === "failed" && /timed out/.test(r.error ?? ""))
            .map((r) => r.agent),
        ],
        psiUnmeasured: psiMobile === null,
        screenshotUnavailable,
      }),
  );
  if (scorer.status === "failed" || !scorer.output) {
    throw new Error(scorer.error ?? "scorer failed");
  }
  // RFL.WEB.10: the pointer follows the audit that just completed. Filter
  // pointed at this row when it was 'pending' only if the lead had no
  // completed audit yet; a forced re-audit keeps showing the previous
  // completed audit until this moment.
  await store.setLatestAudit(search.id, business.id, auditId);

  // Finding 19: exact microcents summed, rounded ONCE per audit (per-call
  // ceil was logging ~2× the real summary spend). Null if any agent answered
  // on a model ai-core cannot price.
  const auditAgents = [health, conversion, presence, traffic, design, reputation, seo];
  await store.logUsageEvent({
    workspace_id: search.workspace_id,
    event_type: "audit_run",
    cost_cents: centsFromMicrocents(sumMicrocents(auditAgents.map((r) => r.costMicrocents))),
    metadata: {
      business_id: business.id,
      audit_id: auditId,
      health_score: scorer.output.health_score,
      sellability_score: scorer.output.sellability_score,
    },
  });
  await broadcastAgentEvent(search.workspace_id, {
    type: "lead.scored",
    businessId: business.id,
    healthScore: scorer.output.health_score,
    sellabilityScore: scorer.output.sellability_score,
  });

  // Sprint 7 (PRD 6.11): the Analyst auto-runs for sellable leads, synthesizing
  // the just-finalized audit into a narrative verdict. It rides the same
  // agent_runs/events lifecycle; a refusal or failure never stalls the job
  // (the deterministic template answers), and its cost is logged as ai_call.
  // Gate (RFL-05): star ≤ 3, sellability ≥ 60, not a chain, not provisional.
  if (
    analystEligible({
      starGrade: scorer.output.star_grade,
      sellabilityScore: scorer.output.sellability_score,
      isChain: business.is_chain === true,
      provisional: false, // the blocked path returned before the agents ran
    })
  ) {
    const auditForAnalyst = await store.getLatestCompletedAuditForBusiness(
      business.id,
    );
    if (auditForAnalyst && auditForAnalyst.provisional !== true) {
      const config = await store.getWorkspaceConfig(search.workspace_id);
      const analyst = await withAgentRun(
        deps,
        {
          job,
          search,
          agent: "analyst",
          targetId: business.id,
          budgetMs: STAGE_BUDGET_MS.analyst,
          signal,
          log,
        },
        (signal) => runAnalyst({ business, audit: auditForAnalyst, config, signal }),
      );
      if (analyst.status === "completed" && analyst.output) {
        await store.updateAudit(auditForAnalyst.id, {
          analyst_output: analyst.output,
        });
        await store.logUsageEvent({
          workspace_id: search.workspace_id,
          event_type: "ai_call",
          cost_cents: analyst.costCents,
          metadata: {
            agent: "analyst",
            business_id: business.id,
            audit_id: auditForAnalyst.id,
            model: analyst.modelUsed,
          },
        });
      }
    }
  }
}

/**
 * agent_runs persistence + AgentEvent emission around one agent call
 * (CLAUDE.md 6.5). The run row starts 'running' so the live view can show
 * in-flight agents, then is finalized from the AgentResult.
 */
async function withAgentRun<T extends Record<string, unknown>>(
  deps: OrchestratorDeps,
  ctx: {
    job: Job;
    search: Search;
    agent: string;
    targetId: string | null;
    /** Stage budget (RFL.QUEUE.8); an overrun becomes a failed run. */
    budgetMs?: number;
    signal?: AbortSignal;
    log?: StageLogger;
  },
  /** Receives the stage budget's signal (RFL.QUEUE.8) to hand to the AI call. */
  run: (signal: AbortSignal) => Promise<AgentResult<T>>,
  legacyOpts?: { budgetMs?: number; signal?: AbortSignal },
): Promise<AgentResult<T>> {
  const { store } = deps;
  const { job, search, agent, targetId } = ctx;
  const budgetMs = ctx.budgetMs ?? legacyOpts?.budgetMs ?? STAGE_BUDGET_MS.agent;
  const signal = ctx.signal ?? legacyOpts?.signal;
  const log = ctx.log ?? stageLogger(job.id, targetId);
  const targetField = targetId === null ? {} : { target: targetId };

  const runRow = await store.insertAgentRun({
    workspace_id: search.workspace_id,
    agent_name: agent,
    job_id: job.id,
    target_id: targetId,
    input: { search_id: search.id },
  });
  await broadcastAgentEvent(search.workspace_id, {
    type: "agent.started",
    agent,
    ...targetField,
  });
  await broadcastAgentEvent(search.workspace_id, {
    type: "agent.progress",
    agent,
    message: `${agent} running (budget ${Math.round(budgetMs / 1000)}s)`,
    ...targetField,
  });

  const t0 = log.start(agent);
  let result: AgentResult<T>;
  try {
    result = await withBudget(agent, budgetMs, (stageSignal) => run(stageSignal), signal);
    log.end(agent, t0, result.status);
  } catch (err) {
    if (err instanceof StageAbortedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.end(agent, t0, isStageTimeout(err) ? "TIMEOUT" : `ERROR ${message}`);
    result = {
      agent,
      status: "failed",
      output: null,
      error: message,
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - t0,
      guardrailPassed: false,
      guardrailNotes: null,
    } as AgentResult<T>;
  }
  await broadcastAgentEvent(search.workspace_id, {
    type: "agent.progress",
    agent,
    message: `${agent} ${result.status} in ${Date.now() - t0}ms`,
    ...targetField,
  });

  await store.updateAgentRun(runRow.id, {
    status: result.status,
    output: (result.output as Record<string, unknown> | null) ?? null,
    error: result.error,
    model_used: result.modelUsed,
    tokens_used: result.tokensUsed,
    cost_cents: result.costCents,
    guardrail_passed: result.guardrailPassed,
    guardrail_notes: result.guardrailNotes,
    duration_ms: result.durationMs,
  });
  await broadcastAgentEvent(
    search.workspace_id,
    result.status === "completed"
      ? {
          type: "agent.completed",
          agent,
          result: result.output,
          ...(targetId === null ? {} : { target: targetId }),
        }
      : {
          type: "agent.failed",
          agent,
          error: result.error ?? "unknown",
          ...(targetId === null ? {} : { target: targetId }),
        },
  );

  return result;
}

/**
 * Called by the queue after every job settles: when a search has no
 * queued/running jobs left, stamp it completed.
 */
export async function settleSearchIfDone(
  job: Job,
  deps: OrchestratorDeps,
): Promise<void> {
  const searchId = payloadOf(job).search_id;
  if (!searchId) return;
  const active = await deps.store.countActiveJobsForSearch(searchId);
  if (active > 0) return;
  const search = await deps.store.getSearch(searchId);
  if (!search || search.status === "completed" || search.status === "failed") {
    return;
  }
  await deps.store.updateSearch(searchId, {
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  console.log(`[orchestrator] search ${searchId} completed`);
}
