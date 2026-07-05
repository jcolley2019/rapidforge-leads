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
