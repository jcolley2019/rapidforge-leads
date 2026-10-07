/**
 * PlacesClient selector (Sprint 2 modified constraint): real Google client
 * when GOOGLE_PLACES_API_KEY is set, fixture client otherwise. The worker
 * logs which mode it is in at startup — flipping to live is an env change,
 * zero code changes.
 */
import { forceFixtures } from "../env";
import { FixturePlacesClient } from "./fixture-client";
import { GooglePlacesClient } from "./google-client";
import type { PlacesClient } from "./types";

export * from "./types";
export { FixturePlacesClient, NEARBY_RESULT_CAP } from "./fixture-client";
export { GooglePlacesClient, PlacesApiError } from "./google-client";
export {
  DEAD_FIXTURE_HOSTS,
  FIXTURE_BUSINESSES,
  FIXTURE_CENTER,
} from "./fixtures";

/** Opt-in that lets fixture businesses into a Supabase-backed worker. */
export const ALLOW_FIXTURES_IN_SUPABASE_ENV = "RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE";

/**
 * RFL.FIX.3j: fixture businesses (google_place_id 'fx-…') must never reach
 * the live workspace again — 25 did, and they surfaced as Builder Brief
 * "competitors". When the store is Supabase (SUPABASE_URL set and the
 * memory store not forced) the fixture client is refused at startup unless
 * RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE=true.
 */
function refuseFixturesInSupabase(reason: string): void {
  const supabaseStore =
    Boolean(process.env.SUPABASE_URL) &&
    process.env.RAPIDFORGE_FORCE_MEMORY_STORE !== "true";
  if (!supabaseStore || process.env[ALLOW_FIXTURES_IN_SUPABASE_ENV] === "true") {
    return;
  }
  throw new Error(
    `[places] refusing to start: fixture Places (${reason}) would write fx-* businesses into Supabase (SUPABASE_URL is set). Set ${ALLOW_FIXTURES_IN_SUPABASE_ENV}=true to allow it deliberately.`,
  );
}

export function createPlacesClient(): PlacesClient {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (forceFixtures()) {
    refuseFixturesInSupabase("RAPIDFORGE_FORCE_FIXTURES=true");
    console.log("[places] mode: fixture (RAPIDFORGE_FORCE_FIXTURES)");
    return new FixturePlacesClient();
  }
  if (apiKey) {
    console.log("[places] mode: google (GOOGLE_PLACES_API_KEY present)");
    return new GooglePlacesClient(apiKey);
  }
  refuseFixturesInSupabase("GOOGLE_PLACES_API_KEY absent");
  console.log(
    "[places] mode: fixture — GOOGLE_PLACES_API_KEY absent; serving 25 Treasure Valley fixture businesses",
  );
  return new FixturePlacesClient();
}
