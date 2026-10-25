/**
 * Seam override (Sprint 4): RAPIDFORGE_FORCE_FIXTURES=true pins every
 * EXTERNAL-API seam (places, probe, site, psi, ai) to fixture/template
 * mode regardless of which keys are present, so UI/E2E work never spends
 * real quota. The DataStore seam is deliberately NOT covered — Realtime
 * broadcast and state recovery need live Supabase.
 */
export function forceFixtures(): boolean {
  return process.env.RAPIDFORGE_FORCE_FIXTURES === "true";
}

/**
 * RFL.QUEUE.8a: real-browser work — Puppeteer screenshots and the PDF report
 * render — is OPT-IN. Unless SCREENSHOTS_ENABLED=true, the worker never
 * imports puppeteer-core or launches Chrome: live audits skip the screenshot
 * stage and the report route answers 503. Fixture mode is unaffected (its
 * pre-rendered JPEGs and HTML report involve no browser).
 */
export function screenshotsEnabled(): boolean {
  return process.env.SCREENSHOTS_ENABLED === "true";
}

/** RFL.PSI.1: default and bounds for PSI_MOBILE_RUNS. */
export const PSI_MOBILE_RUNS_DEFAULT = 2;
export const PSI_MOBILE_RUNS_MAX = 3;

/**
 * RFL.PSI.1: how many parallel mobile PSI runs an audit merges (one mobile
 * run swings ±10 performance points). Unset, blank or not an integer → 2;
 * otherwise clamped to 1–3. Desktop (PSI_DESKTOP) always runs once.
 */
export function psiMobileRuns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PSI_MOBILE_RUNS?.trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return PSI_MOBILE_RUNS_DEFAULT;
  return Math.min(PSI_MOBILE_RUNS_MAX, Math.max(1, n));
}

/** The Vite dev server — always allowed, so local dev never needs WEB_ORIGINS. */
export const LOCAL_WEB_ORIGIN = "http://localhost:5173";

/**
 * RFL.HOST.6: browser origins the worker answers cross-origin (CORS) — the
 * hosted web app (Vercel) calling the hosted worker (Railway). WEB_ORIGINS is
 * comma-separated; entries are trimmed and a trailing slash dropped (an
 * Origin header never carries one). Unset → localhost only.
 */
export function webOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set([LOCAL_WEB_ORIGIN, ...extra])];
}
