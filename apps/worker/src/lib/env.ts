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
