/**
 * Places address parsing (RFL.FIX.3b) — the ONE city parser. SEO's local
 * keyword checks and the Builder Brief's keywords both read it; the two
 * local copies they had read "ID 83686" as the city for every Places (New)
 * `formattedAddress`, which ends in a country part.
 */

/** A state code, optionally with a ZIP: "ID 83686", "ID 83686-1234", "ID". */
const STATE_PART_RE = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;
/** A trailing state (+ ZIP) sharing the city's part: "Boise ID 83702". */
const TRAILING_STATE_RE = /\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;
const COUNTRY_RE = /^(USA|US|United States( of America)?)$/i;

/**
 * City from a Places-formatted address: the part before the state/ZIP part,
 * after dropping a trailing country.
 *   "11567 Lake Shore Dr, Nampa, ID 83686, USA" → "Nampa"   (Places New)
 *   "1120 N Main St, Meridian, ID 83642"        → "Meridian"
 *   "8990 W Overland Rd, Boise ID"              → "Boise"
 * Null when no city can be told apart.
 */
export function cityFromPlacesAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length > 0 && COUNTRY_RE.test(parts[parts.length - 1]!)) parts.pop();
  const statePart = parts.findIndex((part, i) => i > 0 && STATE_PART_RE.test(part));
  if (statePart > 0) return parts[statePart - 1] || null;
  if (parts.length >= 2) {
    const city = parts[parts.length - 1]!.replace(TRAILING_STATE_RE, "").trim();
    return city || null;
  }
  return null;
}
