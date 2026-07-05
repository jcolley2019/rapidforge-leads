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
export { GooglePlacesClient } from "./google-client";
export {
  DEAD_FIXTURE_HOSTS,
  FIXTURE_BUSINESSES,
  FIXTURE_CENTER,
} from "./fixtures";

export function createPlacesClient(): PlacesClient {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (forceFixtures()) {
    console.log("[places] mode: fixture (RAPIDFORGE_FORCE_FIXTURES)");
    return new FixturePlacesClient();
  }
  if (apiKey) {
    console.log("[places] mode: google (GOOGLE_PLACES_API_KEY present)");
    return new GooglePlacesClient(apiKey);
  }
  console.log(
    "[places] mode: fixture — GOOGLE_PLACES_API_KEY absent; serving 25 Treasure Valley fixture businesses",
  );
  return new FixturePlacesClient();
}
