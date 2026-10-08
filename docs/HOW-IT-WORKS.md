# How RapidForge Leads works

Written for Joey from the code on `main` as of 2026-10-07 (`d81e36a`, after the RFL.FIX.3a–3f fixes). Every fact below comes from a file in this repo; the path is given in parentheses the first time a mechanism appears. Where `RapidForge-PRD.md` says something different, the code wins and the last section lists the difference.

---

## What RapidForge Leads does

You type a business category (a Google Places type such as `plumber`) and an area (a zip code or a map pin, plus a radius of 1–25 miles). The worker asks Google Places for every matching business in that circle, stores them, and then works through them five at a time. Businesses with no website, or only a social profile, become instant hot leads. Businesses with a dead site are flagged "Site broken — urgent". Every other live site gets a full audit: the worker fetches the homepage once, runs Google PageSpeed Insights, and hands the same measured facts to seven audit agents. A deterministic Scorer then turns those facts into a Website Health score (0–100), a star grade (1–5) and a Sellability score (0–100). For the best prospects an AI Analyst writes a short verdict automatically; from the lead drawer you can then generate a Builder Brief (a rebuild spec), a Design Brief (JSON for the demo-site generator), a Sales Script and a PDF report. The rule throughout: code measures, scores are math, and AI only explains what was measured.

---

## How a search runs, start to finish

**1. You start a search.** The New Search screen sends `POST /api/searches` with `mode` (`zip_radius` or `map_draw`), `category`, and `params`: `zip` or `lat`/`lng`, `radius_miles` (1–25), `min_reviews` (default 0), `min_rating` (default 0) and `exclude_chains` (default **true**) (packages/shared/src/schemas.ts). The worker writes a `searches` row (status `pending`), adds one `jobs` row with `job_type = 'scout'`, and answers `202 {search_id, status: "queued"}` (apps/worker/src/http.ts).

**2. The job poller claims it.** Every 2 seconds the worker claims the oldest `queued` job, flips it to `running` and adds 1 to `attempts`. It keeps claiming until 5 jobs are in flight (`AUDIT_CONCURRENCY_CAP`) (apps/worker/src/queue.ts, apps/worker/src/orchestrator.ts). A job that throws is retried once (`MAX_JOB_ATTEMPTS = 2`), then parked as `failed`. Only two job types exist in the code: `scout` and `audit_business`.

**3. Scout finds the businesses (no AI).** The search goes to `scouting`. Scout turns the zip into a point, covers the circle with one or more Places Nearby Search calls, removes duplicates and anything outside the true radius, keeps the nearest 100, fetches Place Details for records missing a website or phone, flags chains, classifies each website, and upserts `businesses` plus one `search_results` row per business. The orchestrator then adds one `audit_business` job per business and sets the search to `auditing` (or straight to `completed` if nothing was found).

**4. Filter decides each business's route (no AI).** Each `audit_business` job runs under a 4-minute ceiling (`AUDIT_CEILING_MS`). Filter checks the gates (operational, minimum reviews, minimum rating, chain exclusion), then routes:
- no website or social-only → hot lead, sellability 95, done;
- a completed, non-provisional audit less than 30 days old → reused ("cache hit"), done (skipped when you force a re-audit);
- otherwise the URL is probed: dead → health 10, done; blocked by bot protection → provisional neutral scores, done; alive → a `pending` audit row, and the job continues.

Filter writes the `audits` row and points `search_results.latest_audit_id` at it. It also buys Place Details for hot leads and live sites if Scout didn't already store them.

**5. Shared measurements, taken once and in parallel** (orchestrator.ts `runAuditPipeline`):
- homepage HTML (15 s budget; this is the only stage whose failure fails the audit);
- PSI mobile (45 s budget). An HTTP 429 or 5xx is retried once after 2 s; a second failure, any other error status or a timeout leaves PSI unmeasured (apps/worker/src/lib/psi.ts). PSI desktop runs only with `PSI_DESKTOP=true`; otherwise the desktop slot reuses the mobile result and Health records `desktop_measured: false`;
- homepage screenshots, only with `SCREENSHOTS_ENABLED=true` (30 s budget);
- existence checks for `/sitemap.xml` and `/robots.txt`.

Each PSI run logs a `usage_events` row (`pagespeed_call`, cost 0).

**6. Bot-protection guard.** If the homepage itself turns out to be a challenge page, the audit is finalized as provisional, `lead.scored` fires, and no agent runs.

**7. Screenshots are stored** in the Supabase Storage bucket `screenshots` before the agents start, so the drawer has them even if an agent fails.

**8. Seven audit agents run in parallel** on the same inputs, 60 s budget each: Health, Conversion, Presence, Traffic, Design, Reputation, SEO. One failed agent does not fail the job; the Scorer treats its fields as unmeasured.

**9. Scorer does the math (no AI).** It computes Health, star grade, Sellability and the issues list and finalizes the audit row as `completed`. It moves `latest_audit_id` to that row, logs `usage_events` `audit_run` with the summed AI cost of the seven agents (rounded once), and broadcasts `lead.scored`.

**10. The Analyst may auto-run** (120 s budget) when star ≤ 3 AND sellability ≥ 60 AND not a chain AND not provisional. It writes `audits.analyst_output` and logs a `usage_events` `ai_call` row.

**11. The search settles.** After every job, if the search has no queued or running jobs left, it is stamped `completed` (`settleSearchIfDone`).

**12. Everything else is on demand** from the lead drawer: Builder Brief, Design Brief, Sales Script, PDF report and re-audit. Builder Brief, Design Brief and Sales Script return the result already stored on the audit unless the request carries `?force=true` (apps/worker/src/http.ts). Each on-demand agent runs under the Analyst's 120 s budget (apps/worker/src/agents/on-demand.ts). A running search can be cancelled. (See "What the web app shows".)

**Lifecycle every agent shares.** Every pipeline agent is wrapped by `withAgentRun` (orchestrator.ts):
1. An `agent_runs` row is inserted as `running`.
2. Events `agent.started` and `agent.progress` are broadcast.
3. The agent runs under its budget.
4. The row is finalized with `status`, `output`, `error`, `model_used`, `tokens_used`, `cost_cents`, `guardrail_passed`, `guardrail_notes`, `duration_ms`.
5. `agent.completed` or `agent.failed` is broadcast.

Events go to the Realtime channel `workspace:{id}` under the event name `agent_event`. They are sent as stateless REST broadcasts with the service-role key, and a failed broadcast never fails a job (apps/worker/src/events.ts, packages/shared/src/events.ts).

**Safety nets** (queue.ts, apps/worker/src/lib/budget.ts):

| Mechanism | What it does |
|---|---|
| Stage budgets | probe 15 s · homepage 15 s · PSI 45 s · screenshot 30 s · each agent 60 s · Analyst 120 s. An overrun is skipped and recorded as a low "`<stage>` timed out" issue (a screenshot overrun only in `score_breakdown.stage_timeouts`). Only a probe or homepage overrun fails the audit. On-demand Analyst, Builder Brief, Design Brief and Sales Summary runs use the same 120 s budget; an overrun fails the run and the route answers 502. |
| Retries | Places and PSI retry once after 2 s on HTTP 429/5xx (apps/worker/src/lib/places/google-client.ts, apps/worker/src/lib/psi.ts). AI transport retries live only in AI Core (`maxRetries: 2`). |
| Audit ceiling | 4 min per audit. The queue abandons a job still held at 4 min 30 s (`worker: audit exceeded ceiling`). |
| Stale reclaim | At startup and every 40 s, jobs/agent_runs left `running` for over 10 min by a dead worker are requeued or failed (`stale: reclaimed after worker restart`). |
| Cancel | `POST /api/searches/:id/cancel` fails queued jobs, aborts in-flight ones (`cancelled by user`), sets the search to `failed`. |
| Watchdog | One `[queue] tick` log line every 10 s; a late line reports how long the event loop was blocked. |

```
 New Search (web) ── POST /api/searches ──► searches row + jobs(scout)
                                                   │  poller: every 2 s, ≤ 5 jobs at once
                                                   ▼
 SCOUT ── Places geocode / nearby / details ──► businesses, search_results
   │  one jobs(audit_business) per business
   ▼
 FILTER (per business) ── gates · 30-day cache · probe ──► audits row
   ├─ fails a gate ───────► audit 'skipped' + reason                    [stop]
   ├─ no website / social ► sellability 95 hot lead                      [stop]
   ├─ cache hit (< 30 d) ─► reuse previous audit                         [stop]
   ├─ dead site ──────────► health 10 "Site broken — urgent"             [stop]
   ├─ bot-blocked ────────► provisional: health 50, sellability ≤ 55     [stop]
   └─ live site ──────────► pending audit
                               │
        shared inputs, fetched once, in parallel:
        homepage HTML · PSI mobile (+desktop opt-in) · screenshots (opt-in)
        · /sitemap.xml · /robots.txt        (homepage blocked → provisional, stop)
                               │
   ┌────────┬────────────┬──────────┬─────────┬────────┬────────────┬───────┐
 HEALTH  CONVERSION   PRESENCE   TRAFFIC   DESIGN   REPUTATION    SEO     (parallel)
   └────────┴────────────┴──────────┴────┬────┴────────┴────────────┴───────┘
                                         ▼
                    SCORER (math) ──► audits 'completed' · lead.scored
                                         │
            star ≤ 3 · sellability ≥ 60 · not chain · not provisional?
                                         │ yes
                                         ▼
                    ANALYST ──► audits.analyst_output

 On demand (lead drawer):  BUILDER BRIEF (+ embedded DESIGN BRIEF) ──► audits.builder_brief_md
                           DESIGN BRIEF  ──► audits.design_brief
                           SALES SUMMARY ──► audits.sales_summary
                           PDF report · Re-audit (new audit_business job) · Cancel search
```

**Deterministic vs AI at a glance.** Scout, Filter, Traffic and Scorer never call a model. Health, Conversion, Presence, Reputation and SEO measure in code and only *narrate* with AI. That narration is a deterministic template by default. `AI_SUMMARIES=haiku` (or `all`) narrates all five on Haiku; a comma-separated list of agent names narrates only those, so `AI_SUMMARIES=reputation` (the setting you run) narrates Reputation on Haiku and templates the other four. Unknown names are ignored (`parseAiSummaries`, apps/worker/src/lib/ai.ts). Design calls a vision model only when screenshots exist. Analyst, Builder Brief, Sales Summary and the Design Brief's two judgment fields call a model whenever `ANTHROPIC_API_KEY` is set. Without that key, or with `RAPIDFORGE_FORCE_FIXTURES=true`, every agent uses its deterministic template. Under `npm test` every agent uses its template too unless a test installs a fake provider, and apps/worker/src/test-setup.ts deletes the real keys before any test file loads, so tests never reach the network (`aiSummaryMode`, apps/worker/src/lib/ai.ts).

### Which table holds what

| Table | What it holds | Important columns (real names) | Written by |
|---|---|---|---|
| `searches` | One row per search you run | `mode`, `params` (jsonb), `category`, `status` (`pending` → `scouting` → `auditing` → `completed` / `failed`), `results_count`, `completed_at` | `POST /api/searches`, Scout, queue |
| `businesses` | One row per Google place per workspace (upsert on `workspace_id, google_place_id`) | `google_place_id`, `name`, `phone`, `website_url`, `address`, `lat`, `lng`, `google_rating`, `review_count`, `category`, `business_status`, `is_chain`, `chain_reason`, `name_normalized`, `website_kind`, `places_details` (raw Place Details jsonb), `first_seen_at`, `last_refreshed_at` | Scout, Filter (`places_details`) |
| `search_results` | Links a search to a business; holds your sales status | `search_id`, `business_id`, `latest_audit_id`, `status` (`new` / `called` / `interested` / `sold` / `dead`), `notes`, `last_contacted_at`, `next_followup_at` | Scout, Filter/Scorer (pointer), drawer/pipeline |
| `audits` | One row per audit run (append-only per run) | measured: `ps_performance`, `ps_mobile_performance`, `ps_accessibility`, `ps_seo`, `ps_best_practices`, `ps_lcp_ms`, `ps_cls`, `http_status`, `ssl_valid`, `response_ms`, `platform`, `copyright_year`, `has_phone`, `has_form`, `has_booking`, `has_chat`, `has_viewport_meta`, `has_schema_markup`, `gbp_photo_count`, `has_crux_data`, `screenshot_desktop_url`, `screenshot_mobile_url`; scores: `website_health_score`, `star_grade`, `sellability_score`, `score_breakdown` (jsonb, includes `v15_agents`), `issues`; deliverables: `analyst_output`, `builder_brief_md`, `sales_summary`, `design_brief`; state: `status`, `error_message`, `provisional`, `completed_at` | Filter (insert), Scorer (finalize), Analyst, on-demand routes |
| `jobs` | The work queue itself | `job_type` (`scout` / `audit_business`), `payload` (`search_id`, `business_id`, `force`), `status` (`queued` / `running` / `done` / `failed`), `attempts`, `error`, `started_at`, `finished_at` | API, orchestrator, queue |
| `agent_runs` | One row per agent execution | `agent_name`, `job_id`, `target_id` (business id), `status`, `input` (has `search_id`, or `on_demand` + `audit_id`), `output` (the agent's full output), `error`, `model_used` (null when the template answered, even after a paid model call whose `tokens_used` and `cost_cents` are still logged; apps/worker/src/lib/ai.ts), `tokens_used`, `cost_cents`, `guardrail_passed`, `guardrail_notes`, `duration_ms` | orchestrator, on-demand runner |
| `usage_events` | Spend ledger | `event_type` (`places_call` / `pagespeed_call` / `ai_call` / `audit_run`), `cost_cents`, `metadata` | Scout, Filter, orchestrator, photo route, on-demand runner |
| `workspace_config` | Your six "cascading variables" for prompts | `your_offer`, `target_industry`, `ideal_website_traits`, `sales_tone` (default `direct, friendly, peer-to-peer, no-BS`), `user_location`, `user_brand` (default `RapidForgeAI`) | Settings (`PUT /api/config`) |
| `plans` | Plan limits | `name`, `monthly_search_limit`, `monthly_audit_limit`, `max_radius_miles` (default 25), `max_results_per_search` (default 100), `price_cents` | `bootstrap_workspace()` creates the `founder` plan; the worker never reads it |

Also present: `workspaces`, `workspace_members` (tenancy, supabase/migrations/0001_tenancy.sql) and `schema_migrations` (supabase/migrations/0007_enrichment_and_indexes.sql). Screenshots are files, not a table: they live in the Storage bucket `screenshots` at `{business_id}/{audit_id}/{desktop|mobile}.jpg` (supabase/migrations/0006_screenshots_bucket.sql).

---

## Scoring in one page

All of this is plain math in `packages/shared/src/scoring.ts`. No model ever sets a score.

**Website Health (0–100).** Seven sub-scores, each 0–100, weighted and rounded:

| Term | Weight | How the sub-score is measured |
|---|---|---|
| performance | 0.20 | PSI desktop performance. Desktop PSI is off by default, so this slot holds the **mobile** result unless `PSI_DESKTOP=true`. Unmeasured = 50. |
| mobile | 0.25 | PSI mobile performance; unmeasured = 50 |
| technical | 0.10 | share of 4 checks passed: SSL valid · HTTPS enforced · response < 2,000 ms · viewport meta tag |
| platform | 0.15 | wix 20 · godaddy 20 · squarespace 45 · wordpress 65 · webflow 85 · custom 85 (unknown counts as custom) · `legacy_static` 30. The Scorer turns a detected `custom` into `legacy_static` only when all three hold: no viewport meta, legacy pre-CSS markup, and a `Last-Modified` header older than 730 days or absent (`classifyPlatform`, apps/worker/src/agents/scorer.ts) |
| conversion | 0.15 | share of 5: visible phone · contact form · booking link · CTA above the fold · click-to-call |
| freshness | 0.10 | share of 3: copyright year within 2 years · `Last-Modified` header within 365 days · no broken images |
| design | 0.05 | Design agent's modernity score; 50 if Design produced nothing |

Mobile outweighs desktop (RFL.FIX.3i). Before that change desktop was 0.25 and mobile 0.20, so with `PSI_DESKTOP=true` a fast desktop run could lift a page that fails on phones: Landers (desktop 94, mobile 48) scored 72 · 4★. With the current weights it scores 70, and it grades 3★ because its mobile run fails the healthy-site rule below.

**Star grade** comes from Health: ≥ 85 → 5★ · 70–84 → 4★ · 50–69 → 3★ · 30–49 → 2★ · < 30 → 1★ (whole stars only). Sites failing the healthy-site rule (health ≥ 70 AND PSI mobile performance ≥ 60; null mobile = unmeasured → health ≥ 70 alone) are capped at 3★ whatever their health (`UNHEALTHY_SITE_STAR_CAP`, RFL.FIX.3i.1).

**Sellability (0–100)**, weights as read from `SELLABILITY_WEIGHTS` (these match CLAUDE.md §4.2):

| Term | Weight | Sub-score |
|---|---|---|
| `invertedHealth` | 0.50 | 100 − health (null health → 50) |
| `reviewCount` | 0.15 | 0–4 reviews → 20 · 5–19 → 50 · 20–99 → 80 · 100+ → 100 · null → 50 |
| `ratingQuality` | 0.10 | rating ≥ 3.8 → 100, else 0 · null → 50 |
| `phoneReachable` | 0.10 | phone in Places data → 100, else 0 |
| `notChain` | 0.10 | not a chain → 100, chain → 0 |
| `operational` | 0.05 | `business_status = 'OPERATIONAL'` → 100, else 0 |

**Caps** are applied after blending, and only the lowest applicable cap counts. It is named in `score_breakdown.capped`:

| Cap | Limit | When |
|---|---|---|
| `chain` | 40 | `is_chain` is true |
| `provisional` | 55 | bot-blocked audit |
| `healthy_site` | 55 | health ≥ 70 **and** PSI mobile performance ≥ 60 (`isHealthySite`; null mobile = unmeasured → health ≥ 70 alone). Not applied to blocked audits |

A page with mobile performance below 60 is never capped `healthy_site` and never grades above 3★, whatever its blended health. The line was 50 until RFL.FIX.3i.1: Google's PSI bands call 0–49 poor and 50–89 needs-improvement, and 60 clears the run-to-run noise that moved Landers between mobile 48 and 50. Landers at health 70 with mobile 50 keeps its blended sellability of 62 and grades 3★, so the Analyst auto-runs. The Health narration uses the same rule: such a page is described as "middling", not "healthy".

The no-website / social-only 95 is never capped. A null rating or review count adds a low "Unverified reputation" issue (packages/shared/src/issues.ts).

*Worked example:* health 40, 25 reviews, 4.5★, phone listed, independent, operational:
- Sellability = 60×0.50 + 80×0.15 + 100×0.10 + 100×0.10 + 100×0.10 + 100×0.05 = 30 + 12 + 10 + 10 + 10 + 5 = **77**.
- Health 40 is **2★**, so the Analyst auto-runs.

**Special routing** (apps/worker/src/agents/filter.ts, scoring.ts):

| Situation | Health | Star | Sellability | What you see | Agents run? |
|---|---|---|---|---|---|
| Fails a gate (not operational, too few reviews, low rating, chain with `exclude_chains`) | null | null | null | audit `status = 'skipped'`, reason in `error_message` | no |
| No website (`website_kind = 'none'`) | null | null | 95 | high issue "No website — easiest pitch" | no |
| Social-only (Facebook, Instagram, Yelp, Linktree, TikTok, X/Twitter, LinkedIn URL) | null | null | 95 | high issue "Social-only presence" | no |
| Dead site (HTTP 5xx or unreachable) | 10 | 1★ | formula, then caps | high issue "Site broken — urgent" | no |
| Bot-blocked (HTTP 401/403/429/503 or a Cloudflare/Akamai/Imperva/PerimeterX challenge page) | 50 neutral | null | formula, capped at 55 (40 if chain) | low issue "Site could not be audited (bot protection)", `provisional = true`, never reused by the cache | no |
| Chain that passes the gates (`exclude_chains = false`) | measured | measured | capped at 40 | `score_breakdown.chain = true` | yes, but Analyst never auto-runs |

**Exact Analyst auto-run condition** (`analystEligible`, orchestrator.ts): it runs when all of these hold:
- `star_grade` is not null and ≤ 3;
- `sellability_score` is not null and ≥ 60;
- `is_chain` is not true;
- the audit is not provisional.

It is evaluated only after the Scorer finishes a full audit. So hot leads, dead sites, blocked sites and cache hits never auto-run it.

---

## The 13 agents

Each agent lives in `apps/worker/src/agents/`, with its prompt in `agents/prompts/` and its self-check in `agents/guardrails/`. Thirteen are numbered; 12b, the Design Brief, also runs inside the Builder Brief.

Three shared rules apply to every AI agent (apps/worker/src/lib/ai.ts):

- **Guardrail protocol.** The model's reply must match the agent's Zod schema, which is sent as structured output. It then goes through the guardrail check:
  - fails the guardrail → one more attempt;
  - fails twice → saved with `guardrail_passed = false` plus notes;
  - unparseable JSON, a reply that fails the Zod schema, a refusal, or a transport error → the deterministic template is used instead;
  - cut off at the token limit → retried once with double the limit (the Builder Brief opts out: one call, then its template; `noRetryOnTruncation`).
- **Refusal rule.** A `stop_reason: "refusal"` from any model retries the identical request once on `claude-opus-4-8`. Transport retries happen only inside AI Core (`maxRetries: 2`).
- **Cost.** Cost comes from AI Core's price table (dated 2026-10-03), in dollars per million tokens:

  | Model | Input | Output |
  |---|---|---|
  | `claude-haiku-4-5` | $1 | $5 |
  | `claude-sonnet-5-5` | $2 | $10 |
  | `claude-opus-4-8` | $5 | $25 |

  `claude-fable-5` has no entry, so a Fable run would log a null cost. Cost is carried in exact microcents and rounded to cents per run.

The "measured" cost figures below come from earlier live runs recorded in docs/AUDIT-2026-10.md §(e). The code does not recompute them.

### 1. Scout
- **Job:** find every business of one category inside the search circle and store it.
- **Measures deterministically** (apps/worker/src/agents/scout.ts, apps/worker/src/lib/places/google-client.ts, apps/worker/src/lib/geo.ts, apps/worker/src/lib/chains.ts):
  - Search centre: zip → Places Text Search (`"<zip> USA"`), or the map pin.
  - Tiles: one circle up to 5 km radius; 5 km tiles up to 15 km; 10 km tiles beyond; at most 48 tiles.
  - Per tile, one Places Nearby Search (New), filtered to the category, max 20 results. Fields: id, displayName, formattedAddress, location, rating, userRatingCount, businessStatus, nationalPhoneNumber, websiteUri, primaryType.
  - De-duplicate by place id, drop anything outside the real radius (haversine distance), sort nearest first, keep 100 (`MAX_RESULTS_PER_SEARCH`).
  - Place Details for any record missing a website or phone. This uses the full details mask, which adds types, priceLevel, editorialSummary, regularOpeningHours, photos and reviews.
  - `website_kind`: `none` (no URL) · `social_only` (social host) · `real` · `unknown` (unparseable URL).
  - `is_chain` + `chain_reason`, from three independent checks:
    - `known_brand`: the normalized name starts with a brand in `KNOWN_CHAIN_BRANDS`;
    - `url_shape`: the website link is a store-locator page;
    - `multi_location`: the same normalized name appears at ≥ 3 place ids in this search. The store repeats this check across the whole workspace on every upsert.
- **What the AI judges:** none.
- **Model and settings:** none (deterministic). Places calls: 15 s timeout, one retry after 2 s on 429/5xx, then the job fails.
- **Guardrails:** none (no model output to check).
- **Inputs → outputs:**
  - Reads `searches.category`, `mode`, `params`.
  - Writes `businesses` (all columns listed in the table above), `search_results`, `searches.results_count`, `searches.status`.
  - Logs one `usage_events` `places_call` per Places call (geocode 3¢, nearby 3¢, details 4¢).
  - `agent_runs.output`: `business_ids`, `count`, `tiles`, `places_calls`, `tiles_truncated`.
  - Events: `agent.started` / `agent.progress` / `agent.completed` (no target).
- **Who reads it downstream:** the orchestrator (fan-out); Filter (`website_kind`, gates); Presence, Reputation, Design Brief and Builder Brief (`places_details`); every screen.
- **Typical cost per lead:**
  - $0 AI.
  - Places: per search, 3¢ geocode (zip mode only) + 3¢ per tile, shared across the results.
  - Plus 4¢ for each business that arrived without a website or phone.
- **Known gaps:**
  - `plans.max_results_per_search` / `max_radius_miles` are never read: 100 is hard-coded and the 25-mile limit comes from the request schema.
  - Scout's details call uses the full Enterprise-tier mask. A business missing a phone or website pays 4¢ here even if Filter later skips it. filter.ts's comment that skips "never pay for the Enterprise SKU" holds only for Filter's own fetch.
  - Tile-cap truncation is only logged.

### 2. Filter
- **Job:** decide each business's route before anything is spent: skip, hot lead, cache hit, dead, blocked, or full audit.
- **Measures deterministically** (apps/worker/src/agents/filter.ts, apps/worker/src/lib/probe.ts, apps/worker/src/lib/bot-protection.ts):
  - Gates, in this order:
    - `business_status` present and not `OPERATIONAL` → skip;
    - `review_count` below `min_reviews` → skip;
    - `min_rating` > 0 and `google_rating` below it → skip;
    - `exclude_chains` and `is_chain` → skip.
    - Null review count or rating passes (unknown, not zero).
  - `website_kind` `none` / `social_only` → hot lead.
  - 30-day cache: the newest completed, non-provisional audit with `completed_at` ≤ 30 days old is reused, unless the job has `force`.
  - Liveness probe: a GET with redirects, 10 s timeout and browser-like headers. It reads the first 64,000 bytes, then:
    - a bot signature or HTTP 401/403/429/503 → "unknown" (blocked);
    - HTTP ≥ 500 or a network failure → "no" (dead);
    - anything else → "yes".
  - Place Details (4¢) for hot leads and live sites when `businesses.places_details` is still empty.
- **What the AI judges:** none. No prompt file.
- **Model and settings:** none. Probe budget 15 s; an overrun fails Filter and therefore the job (retried once).
- **Guardrails:** none (deterministic).
- **Inputs → outputs:**
  - Reads `businesses`, `searches.params` and the latest completed audit.
  - Inserts one `audits` row per run (not on a cache hit): `website_url`, `http_status`, `response_ms`, `ssl_valid`, `website_health_score`, `star_grade`, `sellability_score`, `score_breakdown`, `issues`, `status` (`completed` / `pending` / `skipped`), `error_message`, `completed_at`, and `provisional` when blocked.
  - Points `search_results.latest_audit_id` at it. A pending or failed audit never displaces a completed one (apps/worker/src/store/latest-audit.ts).
  - Writes `businesses.places_details` and logs `places_call` usage.
  - `agent_runs.output`: `outcome`, `audit_id`, `sellability`, `health`, `badge`, `reason`, `details_fetched`.
  - Events with `target` = business id.
- **Who reads it downstream:** the orchestrator (only `pending_audit` continues); Scorer finalizes the pending row; Presence, Reputation, Design Brief and Builder Brief read the `places_details` it stored; the Leads table shows the badge and issues.
- **Typical cost per lead:** $0 AI; 4¢ Place Details for a business that passes and has none stored yet.
- **Known gaps:**
  - The PRD's Haiku "edge-pass" is not built; Filter never calls a model.
  - The header comment says chain exclusion is "off by default", but `exclude_chains` defaults to `true` in schemas.ts.
  - `ssl_valid` from the probe only means "the URL is https".

### 3. Health
- **Job:** record the technical facts about the site and summarize them.
- **Measures deterministically** (apps/worker/src/agents/health.ts, apps/worker/src/lib/psi.ts, apps/worker/src/lib/platform.ts, apps/worker/src/lib/site.ts):
  - From PSI (`/pagespeedonline/v5/runPagespeed`): category scores for performance (desktop and mobile), accessibility, SEO and best-practices. Also mobile LCP (ms), CLS, TBT (ms), and whether CrUX field data exists.
  - From the homepage fetch: HTTP status, response time, SSL (final URL is https and the fetch succeeded), HTTPS enforced (final URL after redirects starts with https).
  - Platform fingerprint from URL, HTML and headers: wix · godaddy · squarespace · webflow · wordpress · custom.
  - Latest copyright year in the HTML (© / &copy; / "copyright", 1990 → next year).
  - Whether `Last-Modified` is within 365 days, plus the header's date as ISO (`last_modified_at`; null when absent or unparseable) for the Scorer's stale-site issue and `legacy_static` check.
  - Whether the HTML carries legacy pre-CSS markup (`legacy_markup`, from `hasLegacyMarkup` in apps/worker/src/lib/platform.ts; the patterns are listed under Design).
  - `desktop_measured`: true only when a real desktop PSI run happened; false means `ps_performance` is a copy of the mobile run.
- **What the AI judges:** writes a short interpretation (`reasoning`, `critical_issues`, `summary_one_liner`) citing the numbers. A critical issue's `value` may be a string, number or boolean, so a reply like `ssl_valid: false` parses. Prompt: apps/worker/src/agents/prompts/health.ts.
- **Model and settings:** `claude-haiku-4-5`, only when `AI_SUMMARIES` is `haiku` or lists `health` (no effort parameter; default max 4,096 tokens). **Deterministic template by default.** With desktop PSI off the template says "PSI mobile performance is N/100 (desktop not measured)" instead of quoting the mobile copy as a desktop score. Health runs before the Scorer, so once the audit is scored the orchestrator re-renders the template narration on the Health `agent_runs` row from the final verdict: the one-liner states the health band (4–5★ healthy; 3★ middling, which includes every page with mobile performance below 60 because the star grade is capped at 3★ there, the same rule as the `healthy_site` cap; 1–2★ poor) and the classified platform (`legacy_static` reads "legacy static site", never "custom"), for example "Site is middling: health 60/100 (3★), a legacy static site; mobile performance 99/100 with 1 critical issue(s)." A Haiku narration is kept as the model wrote it.
- **Guardrails** (apps/worker/src/agents/guardrails/health-summary.ts): the reasoning must contain at least 2 numbers, and `critical_issues` can't be empty when the worst performance score is below 50. Fail → retry once → saved flagged.
- **Inputs → outputs:**
  - Reads the shared homepage and PSI.
  - Full output goes to `agent_runs.output`.
  - Scorer copies `ps_performance`, `ps_mobile_performance`, `ps_accessibility`, `ps_seo`, `ps_best_practices`, `ps_lcp_ms`, `ps_cls`, `http_status`, `ssl_valid`, `response_ms`, `platform` (after the Scorer's `legacy_static` check), `copyright_year` into `audits`.
  - Events with target.
- **Who reads it downstream:** Scorer (performance, mobile, technical, platform and freshness terms; the `legacy_static` check; issues); Analyst, Builder Brief and Sales Summary via apps/worker/src/agents/money-facts.ts; PDF report (platform, mobile speed, SSL); drawer Audit tab.
- **Typical cost per lead:**
  - $0 by default.
  - With Haiku: about 0.19¢ (estimate of ~600 input / ~250 output tokens from AUDIT §(e): 600×$1/M + 250×$5/M = $0.00185).
  - Output ceiling 4,096 × $5/M ≈ 2.0¢.
- **Known gaps:**
  - `ps_tbt_ms` is measured but no `audits` column holds it.
  - Broken images are never checked; the Scorer passes `hasBrokenImages: false`, so that freshness check always passes.
  - With desktop PSI off, `ps_performance` holds the mobile value, and the drawer's Audit tab still labels it "Performance (desktop)" (apps/web/src/components/leads/LeadDrawer.tsx). The template and the Scorer's issues no longer present it as a desktop measurement.

### 4. Conversion
- **Job:** find every way a visitor can call, book or write from the homepage.
- **Measures deterministically** (apps/worker/src/agents/conversion.ts), all by parsing the homepage HTML:
  - `tel:` links; visible phone numbers in the page text.
  - `<form>` count and the largest form's field count.
  - Booking links: calendly, cal.com, housecallpro, acuityscheduling, getjobber, setmore, Square appointments, or `/book`, `/schedule`, `/appointment` paths.
  - Chat widgets: livechat, tawk.to, crisp, tidio, intercom, drift, zopim, smartsupp, Facebook chat, podium.
  - Viewport meta; schema.org markup.
  - Up to 5 CTA candidates: link or button text containing call, quote, book, schedule, contact… inside the "above the fold" slice, which is the first 8,000 characters after `</head>` (else from `<body`, else the document start; `aboveFoldSlice`). A bare "Contact" or "Home" inside site chrome is navigation and is dropped. Site chrome is `<nav>`, `<header>` and `<footer>`, plus any `<div>`, `<ul>`, `<aside>` or `<section>` with `role="navigation"` or an id/class token `nav`, `navbar`, `navigation`, `menu` or `sidebar` (a trailing number allowed, e.g. `sidebar1`).
  - `cta_source`: `body` when at least one candidate sits in page content, `nav` when every candidate sits in site chrome, null when there is none.
- **What the AI judges:** CTA strength (`strong` / `weak` / `none`) with quoted element text as evidence. Prompt: apps/worker/src/agents/prompts/conversion.ts.
- **Model and settings:** `claude-haiku-4-5` only when `AI_SUMMARIES` is `haiku` or lists `conversion`; **deterministic template by default**. The template calls CTA strength strong when there is an above-fold CTA plus a tel: link or booking link, and quotes only labels that pass the evidence check below.
- **Guardrails** (guardrails/conversion-summary.ts): every quote must literally appear in the page, and a non-`none` strength needs at least one quote. A quote must also be element text (`isQuotableEvidence`): JSON literals (`true`, `false`, `null`, `[]`, `{}`) are rejected, and so is a one-word quote without a digit.
- **Inputs → outputs:**
  - Scorer writes `audits.has_phone` (visible phone or tel: link), `has_form`, `has_booking`, `has_chat`, `has_viewport_meta`, `has_schema_markup`.
  - Scorer also writes `score_breakdown.v15_agents.conversion`: `cta_candidates`, `booking_url`, `visible_phone`, `has_tel_link`, `has_form`, `has_cta_above_fold`, `cta_source`. No screen reads `cta_source` yet.
  - The summary stays in `agent_runs.output`.
  - Fails (no AI spend) when the homepage fetch returned nothing.
- **Who reads it downstream:** Scorer (conversion and technical terms; `has_viewport_meta` for the `legacy_static` check; issues); Design Brief (primary CTA); money agents via money-facts.ts.
- **Typical cost per lead:** $0 by default; about 0.19¢ with Haiku (same estimate as Health).
- **Known gaps:**
  - "Above the fold" is a character-count slice of the body, not a rendered check.
  - Booking and chat detection uses a fixed provider list.

### 5. Presence
- **Job:** check that the Google listing and the website agree, and read listing depth.
- **Measures deterministically** (apps/worker/src/agents/presence.ts):
  - NAP compare: the Places phone (normalized to 10 US digits) against every phone on the page, and the first line of the Places street address (abbreviations normalized) against the page text. `nap_address_match` is true when Google's street line is on the page, false only when a *different* street address (a house number plus a street suffix such as st, ave, rd, dr or blvd) is on the page, and null when the page shows no street address or Google has none: an absent address is unknown, not a mismatch. `nap_consistent` is true only if phone and address both match, false if either mismatches, otherwise null.
  - Social profile links on the page: Facebook, Instagram, Yelp, LinkedIn, TikTok, YouTube, X/Twitter, Linktree.
  - From `places_details`:
    - photo count;
    - hours completeness: `complete` = 7 days listed · `partial` · `missing` · `unknown` = no details stored.
- **What the AI judges:** a NAP verdict (`consistent` / `mismatch` / `unknown`) plus a narrative. Prompt: apps/worker/src/agents/prompts/presence.ts.
- **Model and settings:** `claude-haiku-4-5` only when `AI_SUMMARIES` is `haiku` or lists `presence`; **deterministic template by default**. The template says which of the three address outcomes it found (on the page, a different address, no address shown).
- **Guardrails** (guardrails/presence-summary.ts): "consistent" needs compared values, and the verdict may not contradict the code's match or mismatch.
- **Inputs → outputs:**
  - Scorer writes `audits.gbp_photo_count`.
  - Scorer writes `score_breakdown.v15_agents.presence`: `social_links`, `hours_completeness`, `gbp_photo_count`, `nap_consistent`, `nap_phone_match`, `nap_address_match`.
  - Fails when the homepage fetch returned nothing.
- **Who reads it downstream:** Scorer (medium issue "Phone or address on the site doesn't match the Google listing" only when `nap_consistent` is false; low issue "Address not shown on the homepage" when Google has an address and the page shows none, packages/shared/src/issues.ts); money-facts.ts (counts Presence as "ran" whenever the business has an address); drawer Audit tab.
- **Typical cost per lead:** $0 by default; about 0.19¢ with Haiku.
- **Known gaps:**
  - The business *name* is never compared; only phone and street are.
  - The PRD's "review response proxy" is not built.

### 6. Traffic
- **Job:** tell whether real people visit the site, for free.
- **Measures deterministically** (apps/worker/src/agents/traffic.ts): whether the PSI response contains CrUX field data (`loadingExperience.metrics`), for mobile and desktop. No extra API call is made.
- **What the AI judges:** none.
- **Model and settings:** none.
- **Guardrails:** none (deterministic).
- **Inputs → outputs:** `agent_runs.output` holds `has_crux_data`, `crux_mobile`, `crux_desktop`; Scorer writes `audits.has_crux_data`.
- **Who reads it downstream:** issues list (low: "No real-user traffic data in the Chrome UX Report"); Analyst's template reasoning; money-facts.ts.
- **Typical cost per lead:** $0 (no AI).
- **Known gaps:** with desktop PSI off, `crux_desktop` simply repeats the mobile reading.

### 7. Design
- **Job:** judge how modern the site looks and feed that into Health's 5% design weight.
- **Measures deterministically** (apps/worker/src/agents/design.ts, apps/worker/src/lib/screenshots.ts). This is the template path, used whenever no screenshots exist:
  - Modernity starts at 75, then subtracts:
    - for the platform: wix 12, godaddy 12, wordpress 8, squarespace 5;
    - for copyright age: 30 at ≥ 10 years, 18 at ≥ 5, 6 at ≥ 2;
    - 20 for a missing viewport tag;
    - 12 for legacy pre-CSS markup (`hasLegacyMarkup`, apps/worker/src/lib/platform.ts): `<font>`, `bgcolor`, table `width`, `align=` on headings, paragraphs, divs, tables, cells or images, `<center>`, Dreamweaver `twoCol*` templates, a Dreamweaver or FrontPage generator meta, or an inline Verdana font stack.
  - The result is clamped to 5–95. "Feels like year" is derived from that score.
  - Every template dimension note starts with `inference:` and says it was estimated from markup, and the drawer's "Vision critique" row reads "estimated (no screenshot)" in template mode.
- **What the AI judges:** looking at the desktop (1440×900) and mobile (390×844) screenshots, it scores modernity, five dimensions (typography, color, imagery, layout, mobile) with notes, a "feels like" year, and critical issues with visual evidence. Prompt: apps/worker/src/agents/prompts/design.ts.
- **Model and settings:** `claude-sonnet-5-5`, effort `low`, maxTokens 1,600. Used only when screenshots exist. Live screenshots need `SCREENSHOTS_ENABLED=true` (Chrome via Puppeteer); fixture mode uses pre-rendered images. Chrome launches with its HTTPS Upgrades / HTTPS-First features disabled (`LAUNCH_ARGS`, apps/worker/src/lib/browser.ts) so `http://` sites load instead of failing with `net::ERR_BLOCKED_BY_CLIENT`. Otherwise the deterministic template is used.
- **Guardrails** (guardrails/design-critique.ts):
  - every dimension note must be ≥ 15 words;
  - no feels-like year after 2024 with modernity < 70;
  - critical issues are required when modernity < 70;
  - each piece of evidence must be ≥ 4 words.
- **Inputs → outputs:**
  - The orchestrator stores screenshot URLs in `audits.screenshot_desktop_url` / `screenshot_mobile_url`.
  - `modernity_0_100` becomes Health's design term.
  - The full critique (with `used_vision`) goes to `score_breakdown.v15_agents.design`.
- **Who reads it downstream:** Scorer (design term; "dated design" issues); money-facts.ts, which turns each `{issue, evidence}` critical issue into its `issue` string, so the Analyst, Builder Brief and Sales Summary see Design's issues; drawer Audit and Screenshots tabs; PDF report (screenshots, absolute URLs only).
- **Typical cost per lead:**
  - $0 without screenshots (the live default).
  - With screenshots: about 2¢. That is 3¢ measured on the retired Sonnet at $3/$15, re-priced to Sonnet 5.5's $2/$10 (3¢ × 2/3).
  - Output ceiling 1,600 × $10/M = 1.6¢ plus the two images.
- **Known gaps:**
  - The template deducts for the *detected* platform, so a page the Scorer reclassifies as `legacy_static` is deducted as `custom` (0) here; its legacy markup still costs 12.

### 8. Reputation
- **Job:** summarize the Google reputation and how fast reviews are arriving.
- **Measures deterministically** (apps/worker/src/agents/reputation.ts, apps/worker/src/lib/yelp.ts):
  - Google rating and review count from Places.
  - Volume band: none 0 · low 1+ · moderate 10+ · high 50+ · very_high 200+.
  - Review velocity: reviews per month since the previous completed audit's snapshot, if that audit is at least 0.25 months old.
  - Up to 5 review texts from `places_details`, highest rating first, ≤ 400 characters each.
  - Yelp: a stub that always returns nothing.
- **What the AI judges:** a verdict (`strong` / `solid` / `mixed` / `weak` / `unknown`), echoes the band, and pulls themes with short verbatim quotes, only from the supplied review text. Prompt: apps/worker/src/agents/prompts/reputation.ts.
- **Model and settings:** `claude-haiku-4-5` only when `AI_SUMMARIES` is `haiku` or lists `reputation` (`AI_SUMMARIES=reputation` narrates this agent alone); **deterministic template by default**. The template's verdict comes from the rating alone (`templateVerdictFor` → `ratingBandFor` in apps/worker/src/agents/prompts/reputation.ts): ≥ 4.6★ strong · ≥ 4.2★ solid · ≥ 3.5★ mixed · below that weak · no rating or zero reviews → unknown. Review volume is a confidence qualifier in the reasoning ("low confidence — fewer than 10 reviews"), never a demotion, so 5.0★ across 7 reviews is "strong". When review texts are on file the template says how many, and that only the model path extracts themes. The system prompt gives the model the same bands.
- **Guardrails** (guardrails/reputation-summary.ts):
  - the band must equal the measured band;
  - the verdict may sit at most one band from the rating's band (strong · solid · mixed · weak); checked when a rating exists and the volume band is not `none`;
  - no quote unless review text was supplied;
  - quotes must be 15 words or fewer (the prompt says the same);
  - quotes must be verbatim from the reviews.
- **Inputs → outputs:**
  - `score_breakdown.v15_agents.reputation` holds everything, including `review_count_at_audit`, which the next audit uses for velocity.
  - Rating and count feed the issues list.
- **Who reads it downstream:** Scorer (issues: medium "No Google reviews yet" at zero reviews, "Only N Google reviews" under 10, poor rating, unverified reputation); money-facts.ts; next audit's Reputation run.
- **Typical cost per lead:** $0 by default; about 0.19¢ with Haiku.
- **Known gaps:**
  - Yelp, BBB and Facebook cross-reference are not built (`rating_divergence` is always null).
  - `last_review_at` is always null.
  - The `audits.gbp_review_velocity` column is never written; velocity lives only in `score_breakdown`.

### 9. SEO
- **Job:** check whether the homepage targets "{category} in {city}" searches.
- **Measures deterministically** (apps/worker/src/agents/seo.ts):
  - `<title>`, meta description, H1s.
  - schema.org types (JSON-LD and microdata).
  - `/sitemap.xml` and `/robots.txt` (null = couldn't tell, never "missing").
  - City from the Places address via `cityFromPlacesAddress` (apps/worker/src/lib/address.ts), the one city parser, shared with the Builder Brief: the part before the state/ZIP part, after dropping a trailing country, so "11567 Lake Shore Dr, Nampa, ID 83686, USA" gives "Nampa".
  - Category = the Places type, kept raw for matching (`category`) and humanised for prose (`category_label`: "general contractor", never "general_contractor").
  - Whether title, H1 and meta mention the city (whole word) and the category. The category matches at a word start through stems per Places type (`CATEGORY_STEMS` in seo.ts: `plumber` → "plumb", `general_contractor` → "contractor", "contracting", "construction", "remodel", "renovat", "handyman"), falling back to the stems of the type's last word, plus the humanised type as a whole word with an optional plural. So "Plumbing" counts for `plumber`.
- **What the AI judges:** a local-fit score from 1 to 5 plus actionable gaps. Prompt: apps/worker/src/agents/prompts/seo.ts.
- **Model and settings:** `claude-haiku-4-5` only when `AI_SUMMARIES` is `haiku` or lists `seo`; **deterministic template by default**. The template starts at 3 and adjusts for local targeting and missing elements; its gaps and local-target line print the humanised category. The system prompt is built per business (`buildSeoSummarySystem`) and names the real "<category> in <city>" target.
- **Guardrails** (guardrails/seo-summary.ts):
  - a code-side invariant: "found" must carry a value, otherwise the agent fails;
  - a score of 5 is rejected unless title, meta description and an H1 all exist.
- **Inputs → outputs:** `score_breakdown.v15_agents.seo`, which includes `h1s` (used by the Design Brief). Fails when the homepage fetch returned nothing.
- **Who reads it downstream:** Scorer (issues: missing title, missing meta, no sitemap, weak local fit); Design Brief (services fallback from H1s); money-facts.ts.
- **Typical cost per lead:** $0 by default; about 0.19¢ with Haiku.
- **Known gaps:**
  - Category matching is only as good as the stem list: a type with no entry and no matching last word relies on its humanised name alone.

### 10. Scorer
- **Job:** turn the seven agents' measurements into the three scores and the issues list, and finalize the audit.
- **Measures deterministically** (apps/worker/src/agents/scorer.ts, packages/shared/src/scoring.ts, packages/shared/src/issues.ts):
  - `classifyPlatform` first: a detected `custom` becomes `legacy_static` (scored 30) when there is no viewport meta, legacy markup is present, and `Last-Modified` is older than 730 days or absent. The effective platform is what `audits.platform` stores.
  - `computeHealthScore`, `deriveStarGrade`, `computeSellabilityScore` and `buildIssues`, using thresholds in `ISSUE_THRESHOLDS`: mobile < 50, desktop < 50 (only when desktop PSI really ran), LCP > 4 s / > 2.5 s, CLS > 0.25, response ≥ 2 s, `Last-Modified` > 730 days, modernity < 40 / < 60, < 10 reviews, rating < 3.5, local fit ≤ 2.
  - Issues built from data the agents already hold (packages/shared/src/issues.ts):
    - high "Placeholder page title" when the found `<title>` is untitled document, home, welcome, index, new page or home page (case-insensitive, trimmed);
    - low "Site not updated in N years (Last-Modified)" when the header is more than 730 days old;
    - medium "No Google reviews yet" at zero reviews (zero is a measurement; a null count gives "Unverified reputation" instead);
    - high "Legacy hand-coded page" for `legacy_static`, in place of "Built on …";
    - low "Address not shown on the homepage" (see Presence).
  - Plus low issues for "Performance could not be measured" and each "`<stage>` timed out". Screenshots never produce an issue: a failed or overrun capture leaves the URLs null, is logged on the stage's end line, and keeps its reason in `score_breakdown.screenshot_unavailable` / `stage_timeouts` only, so no "net::ERR_…" text reaches the rep or a money-agent prompt.
- **What the AI judges:** none.
- **Model and settings:** none.
- **Guardrails:** none (pure functions; a failure throws and fails the job).
- **Inputs → outputs:**
  - Updates the pending `audits` row with every measured column, `website_health_score`, `star_grade`, `sellability_score`, `issues`, `status = 'completed'` and `completed_at` (the time of this write, not the pipeline start).
  - `score_breakdown` holds `health`, `sellability`, `badge` ("Builder site" for wix/godaddy/squarespace, never for `legacy_static`), `chain`, `capped`, `stage_timeouts`, `agents` (which ran) and `v15_agents`.
  - The orchestrator then logs `audit_run` and emits `lead.scored`. When the last agent has stored (the Analyst, when it auto-runs), it stamps `completed_at` again, so the column marks when the pipeline finished.
- **Who reads it downstream:** the Analyst gate; every screen; PDF report; money-facts.ts.
- **Typical cost per lead:** $0 (no AI).
- **Known gaps:** broken images are never checked, and `gbp_review_velocity` is never written (see Health and Reputation).

### 11. Analyst
- **Job:** write the verdict a salesperson reads before calling.
- **Measures deterministically:**
  - Nothing new. It reads one flattened view of the audit (`buildAuditFacts` in apps/worker/src/agents/money-facts.ts): scores, typed audit columns, the `v15_agents` blocks (Design's critical issues as strings), issues, and which agents ran.
  - The prompt embeds that view through `factsToPromptJson`, which drops `agents_run` (already a header line in every money-agent prompt) and Reputation's `google_rating` / `review_count` (echoes of the business row). A fact several agents carry is sent once (`SHARED_FACTS`): when the Scorer's "Not mobile-friendly (missing viewport meta tag)" issue is present, Conversion's `has_viewport_meta` and Design's "not mobile-responsive" critical issue are dropped from the prompt and the issue gets `"source": "conversion"`. Guardrails and templates still read the full view. The Builder Brief and Sales Summary prompts use the same function.
  - Its template fallback builds the verdict from the star grade, priority from sellability (≥ 75 hot, ≥ 50 warm), and the top three issues.
- **What the AI judges:** a verdict (`actively_losing_business` … `excellent`), `sales_lead_priority`, exactly three improvements, 5–8 sentences of reasoning citing at least three agents by name and measured value, and a one-line verdict of 20 words or fewer. It must not re-score. The system prompt (`buildAnalystSystem`) writes for a salesperson at `{user_brand}` in `{user_location}` and asks for the verdict in their `{sales_tone}`; the user prompt adds `{your_offer}`. All four come from workspace_config through `resolveConfigVars` (apps/worker/src/agents/prompts/config-vars.ts), so a blank Settings field becomes its default, never a literal placeholder. Prompt: apps/worker/src/agents/prompts/analyst.ts.
- **Model and settings:** `claude-opus-4-8`, effort `low`, maxTokens 1,500. 120 s budget, both when auto-run and on demand.
- **Guardrails** (guardrails/analyst.ts):
  - fewer than 3 improvements fails;
  - fewer than 3 agents cited fails. An agent counts only when it is named in a sentence that also carries a number; a number-free mention is allowed but not counted. The template states Conversion's booleans as "N of 4 contact paths" for the same reason;
  - a one-liner over 20 words fails;
  - the verdict must fit the star grade (for example "excellent" only at 4–5★).
- **Inputs → outputs:**
  - Writes `audits.analyst_output`.
  - Logs a `usage_events` `ai_call` row.
  - Its `agent_runs` row goes through the normal lifecycle with target.
- **Who reads it downstream:** drawer Overview tab; Sales Summary prompt; PDF report (verdict and improvements); Design Brief (`one_line_verdict` becomes `current_site_problem`).
- **Typical cost per lead:**
  - About 3¢ (measured, same model and effort).
  - Output ceiling 1,500 × $25/M = 3.75¢ per attempt.
  - Only eligible leads pay it.
- **Known gaps:**
  - `POST /api/businesses/:id/analyst` exists, but no screen calls it: `generateAnalyst()` in apps/web/src/lib/api.ts is unused. Analyst output appears only where the auto-run wrote it.
  - Each on-demand call re-spends: unlike the other on-demand routes, the Analyst route has no stored-result reuse.
  - The comment next to `MODEL_SONNET` in lib/ai.ts still lists the Analyst; the code uses `MODEL_OPUS`. The analyst.ts header still says it auto-runs for sellability ≥ 60, leaving out the star, chain and provisional conditions.
  - Its template's padding improvement prints the raw Places type ("help general_contractor rank locally").

### 12. Builder Brief
- **Job:** produce a paste-ready markdown spec a developer (or Claude Code) can build the replacement site from.
- **Measures deterministically:**
  - The same audit facts.
  - Up to four target keywords from the humanised category and the city from `cityFromPlacesAddress`, for example "general contractor Nampa", "best general contractor in Nampa", "Nampa general contractor company", "general contractor near me" (`deriveKeywords`, apps/worker/src/agents/prompts/builder-brief.ts).
  - The top 3 same-category businesses in your workspace by review count, presented as "competitors". Chains and fixture rows (`google_place_id` starting `fx-`) are excluded (`fetchCompetitors`, apps/worker/src/http.ts).
  - A "Google Business Profile" block built from rows already loaded, with no new fetches (`briefBusinessInputsOf`, apps/worker/src/agents/builder-brief.ts): opening hours, the listing's photo count and up to 3 verbatim review quotes (≥ 40 characters, highest rated first) from `businesses.places_details`, plus the audit's screenshot URLs. Anything not held prints as unknown, none held or not captured.
  - A ≤ 1,500-character text excerpt of a fresh homepage fetch (apps/worker/src/http.ts).
  - Its template fallback is a complete 12-section brief (without the Google Business Profile block).
- **What the AI judges:** writes all twelve required H2 sections in order: Project overview · Business details · Target audience · Pages to build · Design direction · SEO requirements · AEO requirements · Conversion requirements · Performance requirements · Content to migrate · Assets · Deploy instructions. The client stack is fixed as Vite + React + Tailwind + shadcn/ui. Uses `{your_offer}`, `{ideal_website_traits}`, `{target_industry}`, `{user_location}`. Prompt: apps/worker/src/agents/prompts/builder-brief.ts.
- **Model and settings:** `claude-opus-4-8`, effort `low`, maxTokens 8,000 and exactly one call. A reply cut off at 8,000 is not retried: the `agent_runs` row is recorded `failed` with error "truncated at 8000", and the deterministic template is stored and returned. The request timeout is 120 s, the same as the one 120 s budget that covers the whole run (embedded Design Brief included); the budget starts first, so it wins when both would fire and the route answers 502. It appends the Design Brief (12b) JSON under "## Design Brief (JSON)": the one already stored in `audits.design_brief` when it parses (no new call, so the brief and the Design Brief tab agree), otherwise a fresh one. `?force=true` regenerates it too (`storedDesignBrief`, apps/worker/src/agents/builder-brief.ts).
- **Guardrails** (guardrails/builder-brief.ts):
  - every section must be its own H2 line;
  - no placeholders (`[INSERT …]`, `{business_name}`, lorem ipsum);
  - at most 2,000 words.
  - A Design Brief failure only drops the JSON block.
- **Inputs → outputs:**
  - `audits.builder_brief_md`, a `usage_events` `ai_call` row, and an `agent_runs` row with `input.on_demand = true`.
  - The embedded Design Brief is also saved to `audits.design_brief` when that column is still empty, so the Design Brief tab then shows it without a second call. With `?force=true` the fresh one overwrites a stored one, so the tab and the brief's embedded JSON always match.
  - A stored brief is returned as-is (`stored: true`, no agent run, no spend) unless the request has `?force=true`; the drawer's "Regenerate" button sends it.
  - Events: `agent.started` and `agent.completed` / `agent.failed` only (apps/worker/src/agents/on-demand.ts).
- **Who reads it downstream:** drawer Builder Brief tab (copy and regenerate); you or Claude Code.
- **Typical cost per lead:**
  - About 11¢ measured, plus about 0.4¢ for the embedded Design Brief.
  - Output ceiling 8,000 × $25/M = 20¢ for the one call (thinking tokens count against it).
- **Known gaps:**
  - "Competitors (pulled fresh)" come from stored workspace leads, not a new Places search.
  - Screenshots reach the prompt as URLs only; the model never sees the images.
  - The template fallback prints the raw Places type ("a general_contractor serving Nampa").

### 12b. Design Brief
- **Job:** produce the structured JSON brief the rapidforge-demos generator reads to build a demo site.
- **Measures deterministically** (apps/worker/src/agents/design-brief.ts, packages/shared/src/design-brief.ts), using only stored data:
  - `business_name`; `vertical` (Places category → first Places type → `local_service`).
  - Up to 5 `review_quotes`: verbatim, ≥ 40 characters, highest rating first.
  - Up to 8 `photo_urls`: worker photo-proxy URLs (`/api/places/photo/…?maxWidthPx=1600`), never raw Google URLs.
  - `hours` (Sunday-first, `HH:MM`); `phone`; `address`.
  - `primary_cta`: booking link → phone → first CTA text → "Request a quote" form.
  - `current_site_problem`: Analyst one-liner → first issue → generic line.
  - `generated_at` and `source` (`audit_id`, `haiku_model`, `template_fallback`).
- **What the AI judges:** only `tone_descriptors` (3–5) and `services` (1–12), grounded in the homepage excerpt, H1s and review text. Prompt: apps/worker/src/agents/prompts/design-brief.ts.
- **Model and settings:** `claude-haiku-4-5`, maxTokens 600, no effort; 120 s budget on its own route. This is a "judgment" call, so it uses Haiku whenever `ANTHROPIC_API_KEY` is set (it does not depend on `AI_SUMMARIES`). The template fallback picks tones from the category and services from the SEO H1s.
- **Guardrails** (guardrails/design-brief.ts): quotes must be verbatim from `places_details.reviews`, tone and services must be non-empty, and the whole object must parse against `DesignBriefSchema`. Otherwise the agent fails and writes nothing.
- **Inputs → outputs:**
  - On its own route: `audits.design_brief`, plus `agent_runs` and `ai_call` rows. A stored brief is returned without new spend unless `?force=true`.
  - Inside the Builder Brief: the JSON block in the markdown, also saved to `audits.design_brief` when that column is empty. A brief already stored there is embedded as-is instead of making a new call, unless the Builder Brief request has `?force=true`; then the regenerated one overwrites the stored one.
- **Who reads it downstream:** the rapidforge-demos repo; drawer Design Brief tab (shows the photos through the proxy).
- **Typical cost per lead:**
  - Under about 0.4¢: output ceiling 600 × $5/M = 0.3¢, plus input. The input is a short system prompt, ≤ 1,500 characters of excerpt and ≤ 5 × 400 characters of reviews, ≈ 1,000 tokens at ~4 characters per token, so ≈ 0.1¢.
  - Each photo the tab loads costs 1¢ (`places_call`, endpoint `photo`).
- **Known gaps:** photos are re-requested each time the tab renders a brief (up to 8¢ per view, minus whatever the browser cache serves).

### 13. Sales Summary
- **Job:** write a 60-second cold-call script that opens with one measured fact.
- **Measures deterministically:**
  - The same audit facts, plus the stored Analyst verdict if there is one.
  - The template picks the most concrete measured problem in this order: mobile speed < 70 → design < 70 → no tap-to-call → health score.
- **What the AI judges:** opener, earned observation, pain hypothesis, offer, soft close, full talk track (≤ 150 words) and 2–3 objections with responses. The system prompt (`buildSalesSummarySystem`) says the rep is calling on behalf of `{user_brand}` in `{user_location}`, asks the opener to say so in one short clause, and sets the voice to `{sales_tone}`; the user prompt adds `{your_offer}`. All come from workspace_config through `resolveConfigVars`. Prompt: apps/worker/src/agents/prompts/sales-summary.ts.
- **Model and settings:** `claude-sonnet-5-5`, effort `low`, maxTokens 1,200, 120 s budget.
- **Guardrails** (guardrails/sales-summary.ts):
  - the observation must contain a digit or a measurement word;
  - the talk track must be ≤ 150 words;
  - no banned words (synergy, leverage, unlock, empower, circle back, touch base, deep dive);
  - at least 2 objections.
- **Inputs → outputs:** `audits.sales_summary`, an `ai_call` usage row, and an on-demand `agent_runs` row with start/finish events. A stored script is returned as-is (`stored: true`, no spend) unless the request has `?force=true`; the drawer's "Regenerate" button sends it.
- **Who reads it downstream:** drawer Sales Script tab.
- **Typical cost per lead:**
  - About 1.3¢: 2¢ measured on the retired Sonnet, × 2/3 for Sonnet 5.5 pricing.
  - Output ceiling 1,200 × $10/M = 1.2¢.
- **Known gaps:** the template fallback ignores the workspace voice (it reads no cascading variable) and prints the raw Places type ("websites for local general_contractor").

---

## What the web app shows

The left rail has eight views (apps/web/src/views/views.ts). The web app holds no secrets. It reads the worker's HTTP API with your Supabase login token and listens to the Realtime channel (apps/web/src/lib/api.ts, apps/web/src/features/live/useWorkspaceLive.ts).

| Screen | What it shows | Data it reads |
|---|---|---|
| Sign-in | Supabase Auth login (apps/web/src/features/auth/AuthPage.tsx) | Supabase |
| Dashboard | Recent searches, usage, lead KPIs | `GET /api/searches`, `GET /api/usage`, `GET /api/leads` |
| Workspace | The live view of one search: chip bar **All · scout · filter · health · conversion · presence · traffic · design · reputation · seo · scorer** (apps/web/src/lib/agent-state.ts), live results table, per-agent event feed, Cancel button while audits run | `GET /api/searches/:id` (polling fallback) + Realtime `agent_event`; `POST /api/searches/:id/cancel` |
| Pipeline | Kanban by lead status | `GET /api/leads`, `POST /api/leads/:id/status` |
| New Search | Zip/Radius tab and Map tab (Keyword tab shown as "v1.5") | `POST /api/searches` |
| Leads | Every lead across all searches; CSV export (built in the browser); bulk status change and bulk re-audit | `GET /api/leads`, `POST /api/leads/:id/status`, `POST /api/businesses/:id/reaudit` |
| Agents | "Coming soon" placeholder (`StubView`) | — |
| Analytics | "Coming soon" placeholder | — |
| Settings | The six cascading variables | `GET /api/config`, `PUT /api/config` |

**Lead drawer tabs** (apps/web/src/components/leads/LeadDrawer.tsx). Builder Brief, Design Brief and Sales Script stay locked ("Audit this lead first") until the lead's audit is `completed`. Hot leads have completed audits, so they unlock too.

| Tab | What it shows | Data it reads |
|---|---|---|
| Overview | Status dropdown, scores, issues, Analyst verdict if present, PDF report download | `audits` via the lead row, `POST /api/leads/:id/status`, `GET /api/businesses/:id/report` |
| Audit | Per-agent measured data and the per-agent AI cost readout | `audits` columns + `score_breakdown`, `GET /api/businesses/:id/costs` |
| Builder Brief | The markdown brief; generate / regenerate | `audits.builder_brief_md`; `POST /api/businesses/:id/builder-brief` |
| Design Brief | The JSON brief with photos; generate / regenerate | `audits.design_brief`; `POST /api/businesses/:id/design-brief`; `GET /api/places/photo/:ref` |
| Sales Script | Talk track + objections | `audits.sales_summary`; `POST /api/businesses/:id/sales-summary` |
| History | Every audit of this business, newest first | `GET /api/businesses/:id/audits` |
| Notes | Auto-saved notes | `POST /api/leads/:id/status` |
| Screenshots | Desktop + mobile captures | `audits.screenshot_desktop_url` / `screenshot_mobile_url` |

**On-demand actions:**

| Action | Route | What it does | Spend |
|---|---|---|---|
| Analyst | `POST /api/businesses/:id/analyst` | Runs the Analyst on the latest completed audit. Chains get 409 unless `?force=true`. Runs every time (no stored reuse). **No button calls it today.** | ≈ 3¢ |
| Builder Brief | `POST /api/businesses/:id/builder-brief` | Returns the stored brief; `?force=true` (the drawer's "Regenerate") writes a new one and overwrites `audits.design_brief` with the regenerated Design Brief. Without `?force=true` a stored Design Brief is embedded rather than regenerated | ≈ 11.4¢ when generated |
| Design Brief | `POST /api/businesses/:id/design-brief` | Returns the stored brief; `?force=true` regenerates | ≈ 0.4¢ when generated |
| Sales Script | `POST /api/businesses/:id/sales-summary` | Returns the stored script; `?force=true` (the drawer's "Regenerate") writes a new one | ≈ 1.3¢ when generated |
| PDF report | `GET /api/businesses/:id/report` | Two-page report (apps/worker/src/lib/pdf-report.ts). Real PDF needs `SCREENSHOTS_ENABLED=true` (else 503 "screenshots disabled"); fixture mode returns HTML | $0 |
| Re-audit | `POST /api/businesses/:id/reaudit` | Queues an `audit_business` job under the newest search for that business. The drawer and Workspace buttons send `force: true` (skips the 30-day cache). When the audit's `lead.scored` arrives, the web bumps `leadsVersion` (debounced 500 ms), so the Leads list, an open command palette and the drawer show the new score without a reload | a fresh audit |
| Cancel search | `POST /api/searches/:id/cancel` | Fails queued jobs, aborts running ones, search → `failed`; 409 if already finished | $0 |

Other routes: `GET /health` (no login; queue and mode readout) and the static `/fixtures/screenshots` route for fixture images.

---

## Cost per lead

**Assumptions.**
- Live keys are set (Places, PSI, Anthropic).
- Prices are AI Core's table, dated 2026-10-03.
- The example search is a 3-mile zip search. 3 mi = 4,828 m ≤ 5 km, so one tile (apps/worker/src/lib/geo.ts). That is 1 geocode (3¢) + 1 nearby call (3¢) = 6¢, returning 20 businesses (Nearby Search caps at 20), so the **search share is 6¢ ÷ 20 = 0.3¢ per lead**. Bigger searches scale the same way: for example, 10 miles = 9 tiles = 30¢ for up to 100 leads, which is also 0.3¢ each when 100 come back.
- Place Details: 4¢. PSI: free.
- AI figures are the per-agent estimates above: Haiku narration ≈ 0.19¢ each; Design ≈ 2¢; Analyst ≈ 3¢; Builder Brief ≈ 11¢ + 0.4¢ embedded Design Brief; Sales Summary ≈ 1.3¢.
- "Default switches" means `AI_SUMMARIES` unset, `SCREENSHOTS_ENABLED` off and `PSI_DESKTOP` off. "All switches on" means `AI_SUMMARIES=haiku` and `SCREENSHOTS_ENABLED=true`. With `AI_SUMMARIES=reputation` only one narration is paid, so column B becomes 4.3 + 0.19 ≈ 4.5¢.
- The per-agent figures are dated. The live `agent_runs` rows read for docs/AUDIT-2026-10-07.md Part 5 (2026-10-04 to 10-07) show narration at 1–1.5¢ each because they ran on the retired Sonnet before RFL.AI.9 moved narration to templates and Haiku; the Haiku 0.19¢ is an estimate from prompt sizes, not a measured row.

| Line item | A. No-website hot lead | B. Audited, no Analyst (default switches) | B. Audited, no Analyst (all switches on) | C. B + Analyst + Builder Brief + Sales Summary (default switches) | C. same (all switches on) |
|---|---|---|---|---|---|
| Search share (geocode + nearby) | 0.3¢ | 0.3¢ | 0.3¢ | 0.3¢ | 0.3¢ |
| Place Details (Scout for a missing website/phone, else Filter) | 4¢ | 4¢ | 4¢ | 4¢ | 4¢ |
| Scout / Filter / Traffic / Scorer | 0 | 0 | 0 | 0 | 0 |
| PSI (1 call; 2 with `PSI_DESKTOP`) | — | 0 | 0 | 0 | 0 |
| 5 narration summaries | — | 0 (template) | 5 × 0.19 ≈ 0.9¢ | 0 | 0.9¢ |
| Design | — | 0 (template, no screenshots) | ≈ 2¢ | 0 | 2¢ |
| Analyst (auto, if eligible) | — | — | — | 3¢ | 3¢ |
| Builder Brief incl. embedded Design Brief (on demand) | — | — | — | 11 + 0.4 = 11.4¢ | 11.4¢ |
| Sales Summary (on demand) | — | — | — | 1.3¢ | 1.3¢ |
| **Total** | **0.3 + 4 = 4.3¢** | **0.3 + 4 = 4.3¢** | **0.3 + 4 + 0.9 + 2 = 7.2¢** | **4.3 + 3 + 11.4 + 1.3 = 20.0¢** | **7.2 + 3 + 11.4 + 1.3 = 22.9¢** |

**What moves the numbers:**
- Only a deliberate "Regenerate" (`?force=true`) repeats the Builder Brief or Sales Script line; otherwise the stored result comes back free. The on-demand Analyst route re-spends on every call (no button calls it).
- The Design Brief tab adds 0.4¢ the first time it is generated (0 if a Builder Brief already filled `audits.design_brief`), plus 1¢ per photo request that reaches the worker (up to 8 per brief). The reverse also holds: a first Builder Brief after the tab reuses its stored brief and skips the 0.4¢.
- A re-audit repeats column B (or C's Analyst line, if eligible).
- A refusal can add one `claude-opus-4-8` attempt.
- A truncated reply retries at double the token limit, except the Builder Brief, which stops after one call.
- Each agent's output ceiling caps the worst case.
- `agent_runs.cost_cents` rounds each run to the nearest cent, so a 0.19¢ Haiku summary shows as 0¢ there. The `audit_run` usage row sums exact microcents first.

**Against the < $200/month target (CLAUDE.md §8):** $200 = 20,000¢. That is ≈ 2,770 fully-switched-on audits (20,000 ÷ 7.2), or ≈ 870 fully pursued leads (20,000 ÷ 22.9).

---

## Glossary

- **AEO (Answer Engine Optimization):** writing pages so AI assistants can quote them (FAQ pairs, clear entity facts). A required Builder Brief section.
- **agent_runs:** the table with one row per agent execution: status, model, tokens, cost, guardrail result, full output.
- **AI Core (RapidForge AI Core):** your shared library that every model call goes through; it holds retries and the price table. App code never calls Anthropic directly.
- **Audit ceiling:** the 4-minute hard limit on one business's audit.
- **Bot protection / WAF:** a firewall page (Cloudflare "Just a moment…", Akamai "Access Denied"…) that answers instead of the real site.
- **Builder site:** wix, godaddy or squarespace (platform score ≤ 45); gets a "Builder site" badge. `legacy_static` scores 30 but never gets the badge.
- **Cascading variables:** the six `workspace_config` fields (`your_offer`, `target_industry`, `ideal_website_traits`, `sales_tone`, `user_location`, `user_brand`) injected into prompts through one function (`resolveConfigVars`, apps/worker/src/agents/prompts/config-vars.ts), with defaults when blank. The Analyst and Sales Summary read `your_offer`, `user_brand`, `user_location` and `sales_tone`; the Builder Brief reads `your_offer`, `ideal_website_traits`, `target_industry` and `user_location`. The same file humanises Places categories (`general_contractor` → "general contractor") for SEO and the Builder Brief keywords.
- **chain_reason:** why a business is marked a chain: `known_brand`, `url_shape` or `multi_location`.
- **CLS (Cumulative Layout Shift):** how much the page jumps while loading; good is under 0.1.
- **CrUX (Chrome UX Report):** real-visitor data Google includes in PSI only when a site has enough traffic; used as a free traffic signal.
- **CTA (call to action):** a button or link like "Call now" or "Book online".
- **CWV (Core Web Vitals):** Google's page-experience metrics; here LCP, CLS and TBT from PSI.
- **Deterministic:** same input, same output, computed by code; no AI.
- **Effort:** a setting that controls how much the model "thinks" before answering on Sonnet 5.5 / Opus (all agents use `low`); Haiku doesn't take it.
- **Fixture mode:** running without real keys. Places serves 25 Treasure Valley sample businesses, and PSI, homepages and screenshots come from stored samples. `RAPIDFORGE_FORCE_FIXTURES=true` forces it. A worker backed by Supabase (`SUPABASE_URL` set, memory store not forced) refuses to start with fixture Places unless `RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE=true` (apps/worker/src/lib/places/index.ts), so `fx-` businesses can't reach the live workspace again. supabase/migrations/0009_purge_fixture_rows.sql deletes the ones already there (fixture businesses, their audits, results, jobs and agent runs, and fixture-only searches; `usage_events` is kept) in one transaction with before/after counts; like every migration, you paste it into the SQL editor.
- **GBP (Google Business Profile):** the business's Google listing (hours, photos, reviews) we read through Place Details.
- **Guardrail:** a code check on an AI answer (word counts, verbatim quotes, consistency with the scores). Fail → one retry → saved with `guardrail_passed = false`.
- **Hot lead:** a business with no website or only a social profile; sellability 95, never audited.
- **Job poller:** the worker loop that checks the `jobs` table every 2 s and runs up to 5 jobs at once; no Redis.
- **LCP (Largest Contentful Paint):** seconds until the main content shows; good is under 2.5 s.
- **legacy_static:** the Scorer's platform class for a hand-coded page with no viewport meta, pre-CSS markup and no `Last-Modified` within 730 days; platform score 30 (custom is 85) and a high "Legacy hand-coded page" issue.
- **Lighthouse:** Google's page-testing engine behind PSI; produces the 0–100 category scores.
- **MemoryStore:** the in-memory database the worker uses when `SUPABASE_URL` is absent (offline dev).
- **Microcents:** one millionth of a cent; how AI cost is carried before rounding.
- **NAP (Name, Address, Phone):** listing data that should match the website; mismatches hurt local search.
- **Place Details:** the Google Places call that returns hours, photos, reviews etc. for one place (4¢ with our field mask).
- **place_id / `google_place_id`:** Google's permanent id for a place; the de-duplication key.
- **Provisional audit:** scores that are placeholders because bot protection blocked us; health 50, sellability capped at 55, never reused.
- **PSI (PageSpeed Insights):** Google's free API that runs Lighthouse on a URL.
- **Realtime:** Supabase's live push channel; the worker broadcasts agent events on `workspace:{id}` and the web app updates without refreshing.
- **Refusal:** the model declines to answer (`stop_reason: "refusal"`); retried once on `claude-opus-4-8`, then the template answers.
- **RLS (Row Level Security):** database rules that let a logged-in user see only their own workspace's rows.
- **Sellability cap:** a ceiling applied after the weighted math: chain 40, provisional 55, healthy site 55 (health ≥ 70 and mobile ≥ 60).
- **Service-role key:** the Supabase key that bypasses RLS; it exists only in the worker's env.
- **Stage budget:** the time limit for one step (PSI, screenshot, agent…); an overrun is skipped and noted.
- **Stale reclaim:** requeueing jobs a crashed worker left `running` for over 10 minutes.
- **Structured output:** sending the expected JSON shape with the request so the model's reply must fit it.
- **TBT (Total Blocking Time):** how long the page is frozen by scripts while loading.
- **Template (deterministic template):** the code-written answer an AI agent falls back to (no key, narration off, under `npm test`, or AI failure).
- **30-day cache:** a completed, non-provisional audit under 30 days old is reused instead of re-auditing.
- **v15_agents:** the part of `audits.score_breakdown` where Design, Reputation, SEO and the Conversion/Presence extras are stored.
- **website_kind:** `real`, `social_only`, `none` or `unknown`; decides Filter's route.
- **Zod:** the library that checks data against a declared shape (schemas in `packages/shared`).

---

## Where PRD and code differ

| Topic | What the PRD says | What the code does |
|---|---|---|
| Narration model (Health, Conversion, Presence, Reputation, SEO) | Sonnet 4.6 summaries (PRD §3.2, §3.4) | Deterministic template by default; `claude-haiku-4-5` for all five with `AI_SUMMARIES=haiku`, or for the agents a comma list names (`AI_SUMMARIES=reputation`) |
| Design and Sales Summary model | Sonnet 4.6 | `claude-sonnet-5-5`, effort `low` |
| Health weights | performance (desktop) 25 % · mobile 20 % (§4.1) | performance 0.20 · mobile 0.25 (RFL.FIX.3i) |
| Star grade | From health bands alone (§4.2) | Same bands, capped at 3★ when the healthy-site rule fails (mobile below 60) |
| Sellability weights | 40 / 20 / 15 / 10 / 10 / 5 (§4.3) | 50 / 15 / 10 / 10 / 10 / 5, plus caps: chain 40, provisional 55, healthy site 55 (health ≥ 70 and mobile ≥ 60) |
| Platform score | Wix/GoDaddy 20, Squarespace 45, WordPress 65, Webflow/custom 85 (§4.1) | Adds `legacy_static` = 30, assigned by the Scorer to a hand-coded page with no viewport, legacy markup and a stale or missing `Last-Modified` |
| Null reputation | Not addressed | Null rating or review count scores a neutral 50 and adds an "Unverified reputation" issue |
| Analyst auto-run | Sellability ≥ 60 (§6.11) | Star ≤ 3 AND sellability ≥ 60 AND not chain AND not provisional |
| Filter | Deterministic + Haiku edge-pass (§6.2) | Deterministic only; no model call |
| Liveness check | HEAD request; dead or alive | GET + bot-protection detection; a third outcome, "blocked", gives provisional scores |
| Chain exclusion | "Configurable" | `exclude_chains` defaults to true; chains detected by brand list, locator-URL shape and multi-location (search and workspace) |
| 30-day cache key | `businesses.last_refreshed_at` (§5.5) | The audit's own `completed_at`; provisional audits are never reused |
| Place Details | Fetched by Scout for enrichment (§6.1) | Scout fetches only for records missing website/phone; Filter fetches for every lead that passes its gates |
| PSI | Mobile AND desktop (§6.3) | Mobile only by default; desktop with `PSI_DESKTOP=true` (else the desktop term reuses mobile) |
| Screenshots | Always via Puppeteer (§6.8) | Opt-in `SCREENSHOTS_ENABLED=true`; without screenshots Design uses a markup heuristic |
| Reputation sources | Yelp + BBB + Facebook cross-reference (§6.9) | Google only; Yelp client is a stub that returns nothing |
| Presence | Includes a review-response proxy; guardrail rejects social links not in HTML (§6.5) | Neither exists; NAP compares phone and street only |
| Builder Brief inputs | Includes screenshots + GBP data; competitors pulled fresh; Vite or Next.js (§6.12) | Audit facts + stored GBP hours, photo count and review quotes + screenshot URLs + workspace leads as competitors (no chains, no fixtures) + homepage excerpt; stack fixed to Vite + React + Tailwind + shadcn/ui |
| Design Brief | Not in the PRD | Agent 12b, its own route, `audits.design_brief`, embedded in the Builder Brief (which also fills an empty `audits.design_brief`) |
| Keyword Parser | v1.5 agent (§6.14) | Stub (`keyword-parser.ts` returns "not implemented"); keyword mode rejected at the API |
| Refusal fallback | Fable only (§3.4) | Any model's refusal retries once on `claude-opus-4-8` |
| Agents and Analytics views | Stats, toggles, funnel (§7.3) | "Coming soon" placeholders |
| API | Includes `GET /api/agents` (§8) | No such route; adds `GET /api/searches`, `GET /api/leads`, cancel, costs, design-brief, report, places photo, config and audits routes |
| Drawer tabs | 7 tabs (§7.4) | 8 tabs: adds Design Brief; Analyst has no generate button |
| Plan limits | `max_results_per_search` from plan (§6.1) | `plans` is never read; 100 hard-coded, radius ≤ 25 via request schema |
| Budget estimate | ~$0.30–0.80 per fully analyzed business (§3.5) | ≈ 20–23¢ per fully pursued lead at today's prices (see "Cost per lead") |
