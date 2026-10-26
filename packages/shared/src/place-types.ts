/**
 * Google Places (New) types the worker may send as Nearby Search
 * `includedTypes` (RFL.SEARCH.CAT.2). A search whose category is one of
 * these runs Nearby Search (precise type filter); anything else is a free
 * phrase and runs Text Search. Every entry must be spelled exactly as
 * Google's place-types Table A lists it — Nearby rejects anything else.
 *
 * Seeded from the web CATEGORIES picker. The fixture dataset also carries
 * `hvac_contractor` and `landscaper` as primaryType, but those are not
 * Table A types, so they stay out: typed literally they route to Text
 * Search, which Google answers, instead of a 400 from Nearby.
 * `general_contractor` is the same story (Table B: Google returns it as a
 * primaryType but rejects it in includedTypes), so "general contractor"
 * runs Text Search too (RFL.SEARCH.CAT.2.1).
 */
export const KNOWN_PLACE_TYPES: ReadonlySet<string> = new Set([
  // Home services & trades
  "plumber",
  "electrician",
  "roofing_contractor",
  "locksmith",
  "moving_company",
  "painter",
  // Auto
  "car_repair",
  "car_wash",
  "tire_shop",
  // Health & wellness
  "chiropractor",
  "dentist",
  "gym",
  "skin_care_clinic",
  "spa",
  // Other
  "beauty_salon",
  "cafe",
  "florist",
  "hair_salon",
  "lawyer",
  "real_estate_agency",
  "restaurant",
  "veterinary_care",
]);

/** Longest free phrase accepted as a search category (schema + Scout). */
export const CATEGORY_MAX_CHARS = 80;

const PLACE_TYPE_SHAPE = /^[a-z][a-z0-9_]*$/;

/**
 * True when `category` is a Places type code the worker can hand to Nearby
 * Search; false for any free phrase ("hvac", "med spa", "HVAC repair").
 */
export function isPlaceType(category: string): boolean {
  return PLACE_TYPE_SHAPE.test(category) && KNOWN_PLACE_TYPES.has(category);
}
