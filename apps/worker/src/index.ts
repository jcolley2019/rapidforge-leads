/**
 * RapidForge worker — the entire pipeline lives here (PRD 3.1).
 * Local Node/Express in v1; Railway later. Holds ALL secrets.
 *
 * Sprint 2: search API + jobs poller are live. Swappable seams select
 * themselves from env (Sprint 2 modified constraint) and log their mode:
 *   GOOGLE_PLACES_API_KEY absent → FixturePlacesClient + FixtureWebProbe
 *   SUPABASE_URL absent          → MemoryStore + dev-mode auth
 * Flipping to live is an env change — zero code changes.
 */
import "dotenv/config";
import express from "express";
import { CreateSearchRequestSchema } from "@rapidforge/shared";
import { createPlacesClient } from "./lib/places";
import { createWebProbe } from "./lib/probe";
import { createRequireSupabaseJwt } from "./middleware/auth";
import type { OrchestratorDeps } from "./orchestrator";
import { POLL_INTERVAL_MS, startQueuePoller } from "./queue";
import { createDataStore } from "./store";

const app = express();
app.use(express.json());

const port = Number(process.env.WORKER_PORT ?? 8788);
const startedAt = Date.now();

const deps: OrchestratorDeps = {
  store: createDataStore(),
  places: createPlacesClient(),
  probe: createWebProbe(),
};
const poller = startQueuePoller(deps);

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

// TODO(Sprint 5): POST /api/leads/:id/status, POST /api/businesses/:id/reaudit
// TODO(v1.5):    /api/businesses/:id/{analyst,builder-brief,sales-summary},
//                GET /api/agents, GET /api/usage

app.listen(port, () => {
  console.log(
    `[worker] listening on http://localhost:${port} (store: ${deps.store.mode}, places: ${deps.places.mode})`,
  );
});
