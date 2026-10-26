# RFL.SEARCH.CAT.2 — free-text search (Places Text Search), picker becomes suggestions

Why: Joey typed "HVAC" and got plumbers because the search only accepts Google Place type codes from a fixed picker. The user must be able to type any business phrase. Google Places API (New) places:searchText accepts a free textQuery with a location; places:searchNearby (current) only accepts type codes. Keep both paths: a known type code still uses Nearby (precise); anything else uses Text Search.

## 1. Places client (one commit)
apps/worker/src/lib/places/google-client.ts + types.ts: add `textSearch(params: TextSearchParams): Promise<PlaceRecord[]>` calling `${BASE}/places:searchText` with body { textQuery, maxResultCount: 20, locationRestriction: { rectangle: { low, high } } } where the rectangle is the bounding box of the same circle Scout tiles (Text Search's locationRestriction accepts rectangle only; compute it from center+radius). Reuse NEARBY_FIELD_MASK (same fields), toPlaceRecord, request() retry/backoff and the usage emit — emit("text") and make sure the usage_events/cost path counts it like a nearby call (check lib/places/index.ts and the cost table in docs/HOW-IT-WORKS.md for the per-call price; Text Search Pro SKU is billed like Nearby Pro — if the code has a per-SKU table, add the row). Add it to the PlacesClient interface and FixturePlacesClient (fixture returns the same fixture set, ignoring the query, with the same log line pattern as nearbySearch). Tests mirror google-client.test.ts for nearbySearch: body shape, field mask, 429 retry.

## 2. Scout (one commit)
apps/worker/src/agents/scout.ts: decide per search: `isPlaceType(search.category)` = matches /^[a-z][a-z0-9_]*$/ AND is in a KNOWN_PLACE_TYPES set (export it from packages/shared or a worker lib; seed it with every type in the web CATEGORIES list plus the primaryTypes already seen in lib/places/fixtures.ts). Known type → nearbySearch as today. Otherwise → textSearch with textQuery = the user's phrase as typed (trimmed, max 80 chars), per tile. Everything after discovery (dedupe across tiles, chain filter, business.category = record.primaryType ?? search.category) is unchanged. Scout's search log line names the path ("nearby" or "text"). Tests: a type routes to nearby; "hvac repair" routes to text; results dedupe identically.

## 3. Schema + HTTP (one commit)
packages/shared/src/schemas.ts CreateSearchRequestSchema: category stays `z.string().min(1)` but add `.max(80)` and a comment that it is either a Places type or a free phrase. http.ts POST /api/searches: trim and collapse whitespace before storing. Keep the column name `category` (no migration). Tests: 80+ chars → 400; "  HVAC  repair " stored as "HVAC repair".

## 4. Web (one commit)
apps/web/src/components/search/SearchFilterControls.tsx + NewSearchView.tsx (+ MapSearchTab if it renders the same picker): the category control becomes a text input ("What kind of business? e.g. hvac, roofer, med spa") with the existing CATEGORIES rendered beneath it as clickable suggestion chips that fill the input; the chips filter as the user types; a phrase with no chip match is VALID and submits as typed; the submit hint shows "Searching Google for '<phrase>'" when it is free text and "Category: <Label>" when it matches a type. Settings → search defaults: the default category becomes the saved text. Empty input disables submit. CSV export / ResultsTable / Dashboard recent-searches show the phrase as typed. Tests: free phrase submits; chip click fills; empty blocks; recent-searches row shows the phrase.

## 5. Docs (one commit)
docs/HOW-IT-WORKS.md Scout section: the two paths and why; Help page (HelpView) New search section: "type any kind of business; the chips are shortcuts". CLAUDE.md is NOT touched.

## 6. Gate
Typecheck clean; shared ≥ 89, worker and web not below the previous report + new tests; hermetic (fixture client). After Vercel + Railway deploy: with Claude in Chrome at https://app.rapidforgeai.com (Joey approves sign-in) run ONE real search: "hvac" · 83686 · 5 mi, lowest result count available. Confirm results are HVAC businesses (names/primaryType), not plumbers, and report the count and the Places usage events logged for it (nearby vs text). Do not run more than one search.

## 7. Report
Print between "=== REPORT — RFL.SEARCH.CAT.2 ===" and "=== END REPORT ===": commits, routing rule as implemented, the live HVAC search result (count, 3 sample names, path used), test counts, up to three worth-knowing notes.
