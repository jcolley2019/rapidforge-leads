/**
 * Vitest setupFiles entry (RFL.FIX.3a — hermetic tests: no key, no spend).
 *
 * Runs before every test file is imported. Removes every real key and
 * seam toggle the developer's shell may carry (on Joey's PC
 * ANTHROPIC_API_KEY is a Windows user env var), so `npm test` never selects
 * a live seam, never touches the network and never spends money. Tests that
 * need a toggle set it themselves and restore it in afterEach.
 */
const HERMETIC_ENV = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "PAGESPEED_API_KEY",
  "YELP_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SCREENSHOTS_ENABLED",
  "PSI_DESKTOP",
  "AI_SUMMARIES",
  "RAPIDFORGE_FORCE_FIXTURES",
  "RAPIDFORGE_FORCE_MEMORY_STORE",
  "RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE",
] as const;

for (const name of HERMETIC_ENV) delete process.env[name];
