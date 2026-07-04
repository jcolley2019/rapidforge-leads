/**
 * RapidForge worker — the entire pipeline lives here (PRD 3.1).
 * Local Node/Express in v1; Railway later. Holds ALL secrets.
 *
 * Sprint 1 scope: /health endpoint, JWT middleware stub, jobs poller
 * skeleton. Everything no-ops gracefully when env vars are absent.
 */
import "dotenv/config";
import express from "express";
import { requireSupabaseJwt } from "./middleware/auth";
import { POLL_INTERVAL_MS, startQueuePoller } from "./queue";

const app = express();
app.use(express.json());

const port = Number(process.env.WORKER_PORT ?? 8788);
const startedAt = Date.now();

const poller = startQueuePoller();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rapidforge-worker",
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    queue: poller.status,
    poll_interval_ms: POLL_INTERVAL_MS,
  });
});

// All /api routes require a Supabase JWT (PRD Section 8).
app.use("/api", requireSupabaseJwt);

// TODO(Sprint 2): POST /api/searches, GET /api/searches/:id (PRD Section 8)
// TODO(Sprint 5): POST /api/leads/:id/status, POST /api/businesses/:id/reaudit
// TODO(v1.5):    /api/businesses/:id/{analyst,builder-brief,sales-summary},
//                GET /api/agents, GET /api/usage

app.listen(port, () => {
  console.log(`[worker] listening on http://localhost:${port} (queue: ${poller.status})`);
});
