/**
 * RapidForge worker — the entire pipeline lives here (PRD 3.1).
 * Local Node/Express in v1; Railway later. Holds ALL secrets.
 *
 * Bootstrap only: seams select themselves from env (Sprint 2 modified
 * constraint) and log their mode; routes live in http.ts (Sprint 5 made
 * them testable):
 *   GOOGLE_PLACES_API_KEY absent → FixturePlacesClient + FixtureWebProbe
 *   SUPABASE_URL absent          → MemoryStore + dev-mode auth
 * Flipping to live is an env change — zero code changes.
 */
import "dotenv/config";
import { createApp } from "./http";
import { aiSummaryMode, narrationSummaryMode } from "./lib/ai";
import { preloadBrowserModule } from "./lib/browser";
import { getReportRenderer } from "./lib/pdf-report";
import { createPlacesClient } from "./lib/places";
import { createWebProbe } from "./lib/probe";
import { createPsiClient } from "./lib/psi";
import {
  createScreenshotCapturer,
  createScreenshotStorage,
} from "./lib/screenshots";
import { createSiteFetcher } from "./lib/site";
import type { OrchestratorDeps } from "./orchestrator";
import { startQueuePoller } from "./queue";
import { createDataStore } from "./store";

const port = Number(process.env.WORKER_PORT ?? 8788);
const startedAt = Date.now();

const deps: OrchestratorDeps = {
  store: createDataStore(),
  places: createPlacesClient(),
  probe: createWebProbe(),
  psi: createPsiClient(),
  site: createSiteFetcher(),
  screenshotCapturer: createScreenshotCapturer(),
  screenshotStorage: createScreenshotStorage(),
};
console.log(
  `[ai] summary mode: ${aiSummaryMode()}${aiSummaryMode() === "template" ? " — ANTHROPIC_API_KEY absent; summaries are deterministic templates" : ""}; narration summaries (health/conversion/presence/reputation/seo): ${narrationSummaryMode()}${narrationSummaryMode() === "template" ? " (set AI_SUMMARIES=haiku for Haiku 4.5)" : ""}`,
);
// RFL.QUEUE.8a: Chrome work is opt-in (SCREENSHOTS_ENABLED=true). When on,
// puppeteer-core loads here, before the poller claims a job — on Node 24 +
// tsx that load is synchronous and must never run inside a job's stage.
if (deps.screenshotCapturer.mode === "real" || getReportRenderer().mode === "pdf") {
  await preloadBrowserModule();
}
const poller = startQueuePoller(deps);
const app = createApp(deps, poller, startedAt);

app.listen(port, () => {
  console.log(
    `[worker] listening on http://localhost:${port} (store: ${deps.store.mode}, places: ${deps.places.mode})`,
  );
});
