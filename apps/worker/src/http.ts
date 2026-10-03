/**
 * Worker HTTP API (PRD Section 8) — factored out of the bootstrap so routes
 * are testable against a MemoryStore app instance with no listener side
 * effects. All /api routes require a Supabase JWT; the worker holds the
 * service-role key, so workspace isolation is enforced here per route
 * (foreign rows 404, never 403 — no existence leaks).
 */
import express, { type Express } from "express";
import { z } from "zod";
import {
  CreateSearchRequestSchema,
  UpdateLeadStatusRequestSchema,
  UpdateWorkspaceConfigRequestSchema,
  type WorkspaceConfig,
} from "@rapidforge/shared";
import { runAnalyst } from "./agents/analyst";
import { runBuilderBrief } from "./agents/builder-brief";
import { runDesignBrief } from "./agents/design-brief";
import { runOnDemandAgent } from "./agents/on-demand";
import { runSalesSummary } from "./agents/sales-summary";
import { AnalystOutputSchema } from "./agents/prompts/analyst";
import type { CompetitorSummary } from "./agents/prompts/builder-brief";
import { aiSummaryMode } from "./lib/ai";
import {
  PLACE_PHOTO_MAX_WIDTH_PX,
  PLACE_PHOTO_NAME_RE,
  PLACES_COST_CENTS,
} from "./lib/places";
import {
  buildReportHtml,
  getReportRenderer,
  reportFileStem,
  type ReportAnalyst,
} from "./lib/pdf-report";
import {
  FIXTURE_SCREENSHOT_DIR,
  FIXTURE_SCREENSHOT_ROUTE,
} from "./lib/screenshots";
import { createRequireSupabaseJwt } from "./middleware/auth";
import type { OrchestratorDeps } from "./orchestrator";
import { POLL_INTERVAL_MS, type QueuePoller } from "./queue";
import type { DataStore } from "./store";
import { currentMonthStartIso } from "./store/usage";
import type { UpdateSearchResultPatch } from "./store/types";

/** HTML → a compact plain-text excerpt for the Builder Brief prompt. */
function htmlToExcerpt(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

/** Top-3 fresh local competitors from the same workspace + category. */
async function fetchCompetitors(
  store: DataStore,
  workspaceId: string,
  businessId: string,
  category: string | null,
): Promise<CompetitorSummary[]> {
  const leads = await store.listWorkspaceLeads(workspaceId);
  return leads
    .map((l) => l.business)
    .filter((b) => b.id !== businessId && b.category === category)
    .sort((a, b) => (b.review_count ?? 0) - (a.review_count ?? 0))
    .slice(0, 3)
    .map((b) => ({
      name: b.name,
      google_rating: b.google_rating,
      review_count: b.review_count,
      website_url: b.website_url,
    }));
}

/** POST /api/businesses/:id/reaudit body. force bypasses the 30-day cache. */
const ReauditRequestSchema = z.object({
  force: z.boolean().optional().default(false),
});

function defaultConfig(workspaceId: string): WorkspaceConfig {
  return {
    workspace_id: workspaceId,
    your_offer: null,
    target_industry: null,
    ideal_website_traits: null,
    // 0001 column defaults (bootstrap_workspace inserts them in Supabase).
    sales_tone: "direct, friendly, peer-to-peer, no-BS",
    user_location: null,
    user_brand: "RapidForgeAI",
    updated_at: null,
  };
}

export function createApp(
  deps: OrchestratorDeps,
  poller: QueuePoller,
  startedAt: number,
): Express {
  const app = express();
  app.use(express.json());

  // Fixture screenshots (Sprint 6) — fixture-mode audits store relative URLs
  // under this route; the web client resolves them against its API base.
  app.use(
    FIXTURE_SCREENSHOT_ROUTE,
    express.static(FIXTURE_SCREENSHOT_DIR, { maxAge: "1h" }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "rapidforge-worker",
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      queue: poller.status,
      jobs_in_flight: poller.inFlight(),
      poll_interval_ms: POLL_INTERVAL_MS,
      store_mode: deps.store.mode,
      places_mode: deps.places.mode,
      psi_mode: deps.psi.mode,
      site_mode: deps.site.mode,
      ai_mode: aiSummaryMode(),
      screenshot_capture_mode: deps.screenshotCapturer.mode,
      screenshot_storage_mode: deps.screenshotStorage.mode,
    });
  });

  // All /api routes require a Supabase JWT (PRD Section 8).
  app.use("/api", createRequireSupabaseJwt(deps.store));

  /** POST /api/searches → {search_id, status:'queued'} (PRD Section 8). */
  app.post("/api/searches", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const parsed = CreateSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid search request",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      });
      return;
    }

    try {
      const search = await deps.store.createSearch({
        workspace_id: auth.workspaceId,
        created_by: auth.userId,
        mode: parsed.data.mode,
        params: parsed.data.params,
        category: parsed.data.category,
      });
      await deps.store.enqueueJob({
        workspace_id: auth.workspaceId,
        job_type: "scout",
        payload: { search_id: search.id },
      });
      res.status(202).json({ search_id: search.id, status: "queued" });
    } catch (err) {
      console.error("[api] POST /api/searches failed:", err);
      res.status(500).json({ error: "Failed to create search" });
    }
  });

  /** GET /api/searches → recent searches, newest first (S5.5 dashboard). */
  app.get("/api/searches", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    try {
      const searches = await deps.store.listRecentSearches(
        auth.workspaceId,
        limit,
      );
      res.json({ searches });
    } catch (err) {
      console.error("[api] GET /api/searches failed:", err);
      res.status(500).json({ error: "Failed to load searches" });
    }
  });

  /** GET /api/searches/:id → search + leads + agent_states (polling fallback). */
  app.get("/api/searches/:id", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const detail = await deps.store.getSearchDetail(req.params.id);
      // Workspace isolation: a foreign search 404s rather than 403s.
      if (!detail || detail.search.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Search not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error("[api] GET /api/searches/:id failed:", err);
      res.status(500).json({ error: "Failed to load search" });
    }
  });

  /** GET /api/leads → every lead in the workspace, all searches (PRD 7.3). */
  app.get("/api/leads", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const leads = await deps.store.listWorkspaceLeads(auth.workspaceId);
      res.json({ leads });
    } catch (err) {
      console.error("[api] GET /api/leads failed:", err);
      res.status(500).json({ error: "Failed to load leads" });
    }
  });

  /** POST /api/leads/:id/status → status/notes/follow-up patch (PRD Section 8). */
  app.post("/api/leads/:id/status", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const parsed = UpdateLeadStatusRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid status update",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      });
      return;
    }
    try {
      const existing = await deps.store.getSearchResult(req.params.id);
      if (!existing || existing.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      const patch: UpdateSearchResultPatch = {};
      if (parsed.data.status !== undefined) patch.status = parsed.data.status;
      if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
      if (parsed.data.next_followup_at !== undefined) {
        patch.next_followup_at = parsed.data.next_followup_at;
      }
      // A move out of 'new' is a contact action — stamp it (PRD 7.3 cards
      // show "last action"). Client-supplied timestamps are never trusted.
      if (
        patch.status !== undefined &&
        patch.status !== existing.status &&
        patch.status !== "new"
      ) {
        patch.last_contacted_at = new Date().toISOString();
      }
      const lead = await deps.store.updateSearchResult(req.params.id, patch);
      if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      res.json({ lead });
    } catch (err) {
      console.error("[api] POST /api/leads/:id/status failed:", err);
      res.status(500).json({ error: "Failed to update lead" });
    }
  });

  /** GET /api/businesses/:id/audits → audit history, newest first (PRD 7.4). */
  app.get("/api/businesses/:id/audits", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audits = await deps.store.listAuditsForBusiness(business.id);
      res.json({ audits });
    } catch (err) {
      console.error("[api] GET /api/businesses/:id/audits failed:", err);
      res.status(500).json({ error: "Failed to load audits" });
    }
  });

  /** GET /api/businesses/:id/costs → per-agent AI spend readout (PRD 7.2/S8). */
  app.get("/api/businesses/:id/costs", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const costs = await deps.store.getBusinessCostSummary(business.id);
      res.json(costs);
    } catch (err) {
      console.error("[api] GET /api/businesses/:id/costs failed:", err);
      res.status(500).json({ error: "Failed to load costs" });
    }
  });

  /**
   * GET /api/places/photo/:ref?maxWidthPx= → the Places photo bytes (RFL-06).
   * :ref is the URL-encoded photo resource name ("places/{id}/photos/{ref}")
   * from businesses.places_details.photos[].name. The server key never
   * leaves the Places client; the browser only ever sees this route.
   */
  app.get("/api/places/photo/:ref", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const ref = decodeURIComponent(req.params.ref);
    if (!PLACE_PHOTO_NAME_RE.test(ref)) {
      res.status(400).json({ error: "Invalid photo reference" });
      return;
    }
    const requested = Number(req.query.maxWidthPx ?? PLACE_PHOTO_MAX_WIDTH_PX);
    const maxWidthPx = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), PLACE_PHOTO_MAX_WIDTH_PX)
      : PLACE_PHOTO_MAX_WIDTH_PX;
    try {
      const photo = await deps.places.fetchPhoto(ref, maxWidthPx);
      if (!photo) {
        res.status(404).json({ error: "Photo not found" });
        return;
      }
      void deps.store
        .logUsageEvent({
          workspace_id: auth.workspaceId,
          event_type: "places_call",
          cost_cents: PLACES_COST_CENTS.photo,
          metadata: { endpoint: "photo", mode: deps.places.mode },
        })
        .catch((err) => console.error("[api] photo usage log failed:", err));
      res.setHeader("Content-Type", photo.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(Buffer.from(photo.bytes));
    } catch (err) {
      console.error("[api] GET /api/places/photo failed:", err);
      res.status(502).json({ error: "Photo fetch failed" });
    }
  });

  /** POST /api/businesses/:id/reaudit → {job_id} (PRD Section 8). */
  app.post("/api/businesses/:id/reaudit", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const parsed = ReauditRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid re-audit request" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      // Reuse the newest search_result as the audit's search context —
      // that row's latest_audit_id is what the pipeline updates.
      const result = await deps.store.getLatestSearchResultForBusiness(
        business.id,
      );
      if (!result) {
        res
          .status(409)
          .json({ error: "Business has no search result to re-audit under" });
        return;
      }
      const job = await deps.store.enqueueJob({
        workspace_id: auth.workspaceId,
        job_type: "audit_business",
        payload: {
          search_id: result.search_id,
          business_id: business.id,
          force: parsed.data.force,
        },
      });
      res.status(202).json({ job_id: job.id, status: "queued" });
    } catch (err) {
      console.error("[api] POST /api/businesses/:id/reaudit failed:", err);
      res.status(500).json({ error: "Failed to enqueue re-audit" });
    }
  });

  /** POST /api/businesses/:id/analyst → on-demand Analyst (PRD 6.11). */
  app.post("/api/businesses/:id/analyst", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audit = await deps.store.getLatestCompletedAuditForBusiness(
        business.id,
      );
      if (!audit) {
        res.status(409).json({ error: "No completed audit to analyze" });
        return;
      }
      // Chains never get the Analyst (RFL-04/05); a deliberate click can
      // override with ?force=true.
      if (business.is_chain === true && req.query.force !== "true") {
        res.status(409).json({
          error:
            "Analyst does not run on chains/franchises (is_chain). Add ?force=true to run it anyway.",
          code: "is_chain",
        });
        return;
      }
      const config = await deps.store.getWorkspaceConfig(auth.workspaceId);
      const result = await runOnDemandAgent({
        store: deps.store,
        workspaceId: auth.workspaceId,
        agentName: "analyst",
        businessId: business.id,
        auditId: audit.id,
        run: () => runAnalyst({ business, audit, config }),
        persist: (auditId, output) =>
          deps.store.updateAudit(auditId, { analyst_output: output }),
      });
      if (result.status !== "completed" || !result.output) {
        res.status(502).json({ error: result.error ?? "Analyst failed" });
        return;
      }
      res.json({
        analyst: result.output,
        guardrail_passed: result.guardrailPassed,
        guardrail_notes: result.guardrailNotes,
        model_used: result.modelUsed,
      });
    } catch (err) {
      console.error("[api] POST /api/businesses/:id/analyst failed:", err);
      res.status(500).json({ error: "Failed to run analyst" });
    }
  });

  /** POST /api/businesses/:id/sales-summary → on-demand talk track (PRD 6.13). */
  app.post("/api/businesses/:id/sales-summary", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audit = await deps.store.getLatestCompletedAuditForBusiness(
        business.id,
      );
      if (!audit) {
        res.status(409).json({ error: "No completed audit to summarize" });
        return;
      }
      const config = await deps.store.getWorkspaceConfig(auth.workspaceId);
      const result = await runOnDemandAgent({
        store: deps.store,
        workspaceId: auth.workspaceId,
        agentName: "sales-summary",
        businessId: business.id,
        auditId: audit.id,
        run: () => runSalesSummary({ business, audit, config }),
        persist: (auditId, output) =>
          deps.store.updateAudit(auditId, { sales_summary: output }),
      });
      if (result.status !== "completed" || !result.output) {
        res.status(502).json({ error: result.error ?? "Sales summary failed" });
        return;
      }
      res.json({
        sales_summary: result.output,
        guardrail_passed: result.guardrailPassed,
        guardrail_notes: result.guardrailNotes,
        model_used: result.modelUsed,
      });
    } catch (err) {
      console.error("[api] POST /api/businesses/:id/sales-summary failed:", err);
      res.status(500).json({ error: "Failed to run sales summary" });
    }
  });

  /**
   * POST /api/businesses/:id/design-brief → structured Design Brief JSON
   * (RFL.BRIEF.7). Returns the stored audits.design_brief when present
   * (finding 13: no repeat spend) unless ?force=true re-runs the agent.
   */
  app.post("/api/businesses/:id/design-brief", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audit = await deps.store.getLatestCompletedAuditForBusiness(
        business.id,
      );
      if (!audit) {
        res.status(409).json({ error: "No completed audit for a design brief" });
        return;
      }
      const force = req.query.force === "true";
      if (!force && audit.design_brief) {
        res.json({ design_brief: audit.design_brief, stored: true });
        return;
      }
      let siteHtmlExcerpt: string | null = null;
      if (business.website_url) {
        try {
          const site = await deps.site.fetchHomepage(business.website_url);
          if (site) siteHtmlExcerpt = htmlToExcerpt(site.html);
        } catch {
          siteHtmlExcerpt = null;
        }
      }
      const result = await runOnDemandAgent({
        store: deps.store,
        workspaceId: auth.workspaceId,
        agentName: "design-brief",
        businessId: business.id,
        auditId: audit.id,
        run: () => runDesignBrief({ business, audit, siteHtmlExcerpt }),
        persist: (auditId, output) =>
          deps.store.updateAudit(auditId, { design_brief: output }),
      });
      if (result.status !== "completed" || !result.output) {
        res.status(502).json({ error: result.error ?? "Design brief failed" });
        return;
      }
      res.json({
        design_brief: result.output,
        stored: false,
        guardrail_passed: result.guardrailPassed,
        guardrail_notes: result.guardrailNotes,
        model_used: result.modelUsed,
      });
    } catch (err) {
      console.error("[api] POST /api/businesses/:id/design-brief failed:", err);
      res.status(500).json({ error: "Failed to run design brief" });
    }
  });

  /** POST /api/businesses/:id/builder-brief → on-demand rebuild brief (PRD 6.12). */
  app.post("/api/businesses/:id/builder-brief", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audit = await deps.store.getLatestCompletedAuditForBusiness(
        business.id,
      );
      if (!audit) {
        res.status(409).json({ error: "No completed audit for a brief" });
        return;
      }
      const config = await deps.store.getWorkspaceConfig(auth.workspaceId);
      const competitors = await fetchCompetitors(
        deps.store,
        auth.workspaceId,
        business.id,
        business.category,
      );
      let siteHtmlExcerpt: string | null = null;
      if (business.website_url) {
        try {
          const site = await deps.site.fetchHomepage(business.website_url);
          if (site) siteHtmlExcerpt = htmlToExcerpt(site.html);
        } catch {
          siteHtmlExcerpt = null; // best-effort; the brief handles null
        }
      }
      const result = await runOnDemandAgent({
        store: deps.store,
        workspaceId: auth.workspaceId,
        agentName: "builder-brief",
        businessId: business.id,
        auditId: audit.id,
        run: () =>
          runBuilderBrief({
            business,
            audit,
            config,
            competitors,
            siteHtmlExcerpt,
          }),
        persist: (auditId, output) =>
          deps.store.updateAudit(auditId, {
            builder_brief_md: output.markdown,
          }),
      });
      if (result.status !== "completed" || !result.output) {
        res.status(502).json({ error: result.error ?? "Builder brief failed" });
        return;
      }
      res.json({
        builder_brief_md: result.output.markdown,
        word_count: result.output.word_count,
        sections: result.output.sections,
        guardrail_passed: result.guardrailPassed,
        guardrail_notes: result.guardrailNotes,
        model_used: result.modelUsed,
      });
    } catch (err) {
      console.error("[api] POST /api/businesses/:id/builder-brief failed:", err);
      res.status(500).json({ error: "Failed to run builder brief" });
    }
  });

  /** GET /api/businesses/:id/report → 2-page audit report (PDF or HTML). */
  app.get("/api/businesses/:id/report", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const business = await deps.store.getBusiness(req.params.id);
      if (!business || business.workspace_id !== auth.workspaceId) {
        res.status(404).json({ error: "Business not found" });
        return;
      }
      const audit = await deps.store.getLatestCompletedAuditForBusiness(
        business.id,
      );
      if (!audit) {
        res.status(409).json({ error: "No completed audit to report on" });
        return;
      }
      const parsedAnalyst = AnalystOutputSchema.safeParse(audit.analyst_output);
      const analyst: ReportAnalyst | null = parsedAnalyst.success
        ? parsedAnalyst.data
        : null;
      const html = buildReportHtml({
        business,
        audit,
        analyst,
        generatedAt: new Date(),
      });
      const out = await getReportRenderer().render(html);
      res.setHeader("Content-Type", out.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${reportFileStem(business)}.${out.extension}"`,
      );
      res.status(200).send(out.bytes);
    } catch (err) {
      console.error("[api] GET /api/businesses/:id/report failed:", err);
      res.status(500).json({ error: "Failed to render report" });
    }
  });

  /** GET /api/usage → current-month usage_events rollup (PRD Section 8). */
  app.get("/api/usage", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const summary = await deps.store.getUsageSummary(
        auth.workspaceId,
        currentMonthStartIso(),
      );
      res.json(summary);
    } catch (err) {
      console.error("[api] GET /api/usage failed:", err);
      res.status(500).json({ error: "Failed to load usage" });
    }
  });

  /** GET /api/config → the workspace's cascading variables (PRD 7.3 Settings). */
  app.get("/api/config", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const config = await deps.store.getWorkspaceConfig(auth.workspaceId);
      res.json({ config: config ?? defaultConfig(auth.workspaceId) });
    } catch (err) {
      console.error("[api] GET /api/config failed:", err);
      res.status(500).json({ error: "Failed to load config" });
    }
  });

  /** PUT /api/config → update cascading variables (PRD 7.3 Settings). */
  app.put("/api/config", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const parsed = UpdateWorkspaceConfigRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid config update",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      });
      return;
    }
    try {
      const config = await deps.store.updateWorkspaceConfig(
        auth.workspaceId,
        parsed.data,
      );
      res.json({ config });
    } catch (err) {
      console.error("[api] PUT /api/config failed:", err);
      res.status(500).json({ error: "Failed to save config" });
    }
  });

  return app;
}
