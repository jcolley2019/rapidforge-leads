# SESSION_REPORT — Sprint 2 (Scout + Search Flow)

**Date:** 2026-07-04 · **Mode:** Autonomous Session Mode (granted in kickoff Prompt S2)
**Scope:** PRD Section 11 Sprint 2 + the session's modified constraint: build everything behind swappable interfaces so the whole flow runs today with **zero env vars** and flips to live services with **zero code changes**.
**Status: COMPLETE — all acceptance criteria pass, verified in a real browser. Nothing BLOCKED.** The previous Sprint 1 report is preserved in git history (`6a3d718`).

---

## 1. What was built (by commit)

| Commit | What |
|---|---|
| `8675127` | `feat(worker)` — geo math for Scout: haversine, adaptive tile radius (≤5 km single call / 5 km tiles / 10 km tiles), square-grid coverage plan, `MAX_TILES_PER_SEARCH = 48` cost backstop |
| `34714c6` | `feat(worker)` — **PlacesClient** seam: `GooglePlacesClient` (Places API New: searchText geocode, searchNearby, Place Details, FieldMasks, per-call cost cents) + `FixturePlacesClient` (25 realistic Treasure Valley businesses, 20-result cap mirrored, radius math real) + **WebProbe** seam (real HEAD-check w/ GET fallback + 10s timeout · fixture probe answering from `DEAD_FIXTURE_HOSTS`). Selection: `GOOGLE_PLACES_API_KEY` present → google, absent → fixture, logged at startup |
| `d5bfc84` | `feat(worker)` — **DataStore** seam: `SupabaseStore` (service-role, optimistic job claiming, jsonb-contains lookups) + `MemoryStore` (auto when `SUPABASE_URL` absent). Sprint-2-sized contract: searches, jobs, businesses, search_results, audits, agent_runs, usage_events, search-detail read model |
| `0aec4a9` | `feat(shared)` — `ZipRadiusParamsSchema` + `CreateSearchRequestSchema` (form and worker validate against the same Zod), `socialOnly` badge added to `SPECIAL_CASE_BADGES` |
| `8bb1878` | `feat(agent-scout)` — real Scout per PRD 6.1: grid tiling, dedupe by place_id, in-radius post-filter, Details enrichment for records missing website/phone, `website_kind` classification, `is_chain` (35-brand list + ≥3-location detection), upserts, one `usage_events` row per Places call |
| `f26d283` | `feat(agent-filter)` — real Filter per PRD 6.2: deterministic gates (OPERATIONAL, min_reviews, min_rating, configurable chain exclusion) then routing law: none/social_only → sellability-95 hot lead (health null, never audited) · real → probe → dead = health 10 / star 1 / "Site broken — urgent" · live = provisional `pending` audit. Pure `planFilterOutcome()` core, fully unit-testable |
| `9edef51` | `feat(orchestrator)` — job dispatch (`scout` → fan-out `audit_business` per business; filter per business), 2s poller claiming up to 5 concurrent, retry-once then park failed, search lifecycle (pending → scouting → auditing → completed/failed) with auto-completion when jobs drain, `agent_runs` + AgentEvents around every agent call, `POST /api/searches` + `GET /api/searches/:id`, JWT middleware (real `auth.getUser()` verification when configured / dev workspace when not) |
| `dccfd26` | `test(worker)` — 42 unit tests: tiling coverage proof (1 km lattice sweep), classification, chain heuristics, dedupe, usage logging, all filter gates + routing paths, sellability sort |
| `e68b77c` | `feat(web)` — New Search form (zip, radius slider 1–25 + presets, searchable category picker of 20 curated Places types, min reviews, min rating presets, exclude-chains, cost estimate line) + Live Search view (2s polling until settled, status pill, job/filter counters, results table sorted by sellability desc with hot-lead/site-broken/pending/skipped states) + `/api` Vite dev proxy + api client |

## 2. Acceptance results (all run with NO env vars — no `.env` files exist)

| Check | Result |
|---|---|
| `npx tsc --noEmit` in shared / worker / web | **PASS** — exit 0 in all three |
| Tests | **PASS** — 22/22 shared + 42/42 worker (64 total) |
| Worker boots with zero env | **PASS** — `/health` reports `store_mode:"memory"`, `places_mode:"fixture"`, `queue:"polling"`; modes logged at startup |
| API flow end-to-end | **PASS** — `POST /api/searches` (83704 · plumber · 10 mi) → 202 → search `completed` in **11.1s**, 26 jobs done (1 scout + 25 filter), 0 failed |
| Browser flow (Chrome, via Vite at localhost:5173) | **PASS** — form submitted in the UI → Live Search populated **25 businesses**, sorted: 8 hot leads at **95** on top (4 no-website + 4 social-only), dead site at 92 with "Site broken — urgent", live sites 49–80 "est · Audit pending (Sprint 3)", 2 closed businesses dimmed "Skipped · Business status is CLOSED_*" |
| No-website leads at sellability 95 | **PASS** — every unskipped none/social_only lead scored exactly 95 |
| usage_events per Places call | **PASS** — 16 rows per 10-mi search (1 geocode + 9 nearby tiles + 6 details), asserted in tests |
| No keys in browser | **PASS** — web has no secrets; worker-only env; `/api` proxied in dev |

## 3. Decisions made (and why)

1. **Provisional sellability for live real sites.** Audit agents land Sprint 3, but a sort key was needed now. Live sites get a `pending` audit row whose sellability comes from `computeSellabilityScore` with neutral health (the shared function's documented null-health behavior). Marked `provisional: true` in `score_breakdown` and rendered as "80 est". Sprint 3's Scorer appends the real audit row (audits are append-only) and `latest_audit_id` moves.
2. **Gates run before hot-lead routing.** A `CLOSED_PERMANENTLY` business with no website is a skip, not a hot lead — "never skipped" protects against *website-based* skipping, not against calling closed businesses. Unit-tested explicitly.
3. **Skips are persisted audit rows** (`status:'skipped'`, reason in `error_message`) so every scouted business stays visible in the table with its reason, dimmed at the bottom.
4. **Filter's Haiku edge-pass deferred to Sprint 3.** Its PRD triggers (enterprise-CMS fingerprints, spam names) need audit-agent signals that don't exist yet; Sprint 2's filter is 100% deterministic — the sprint spent **$0 in AI**.
5. **WebProbe pairs with the Places mode.** Fixture URLs aren't real; probing them live would mark all 25 dead. `GOOGLE_PLACES_API_KEY` flips both seams together.
6. **Fixture client ignores the category filter** (logged once) so any category demos the full 25-business dataset. Real client filters by Places `includedTypes` as spec'd.
7. **Optimistic job claiming, no new migration.** Single worker process in v1 → a guarded `UPDATE … WHERE status='queued'` suffices; migrations stay 0001–0004. When multiple workers arrive (Railway), add a `claim_next_job()` SQL function with `FOR UPDATE SKIP LOCKED`.
8. **Multi-location chain threshold = 3** same-named locations in one result set (2 felt coincidence-prone; the fixture trio validates it).
9. **`socialOnly` badge added to `SPECIAL_CASE_BADGES`** in `shared/scoring.ts` — a display string, not a weight; the protected-file rule targets the tuning constants, which are untouched.
10. **`lead.scored` Realtime event deferred to the Sprint 3 Scorer** — the event shape requires a numeric healthScore, which hot leads deliberately don't have. agent.started/completed/failed are already emitted through the (Sprint 4) broadcast stub.
11. **Tile cost cap:** worst case 48 nearby calls ≈ $1.55/search; a 25-mile search plans ~39 tiles. Logged when the cap ever truncates.
12. **Category picker is a curated 20-type list** of Places (New) Table A types I'm confident exist. I did NOT include an HVAC-specific type (uncertain it exists in Table A — verify against the live API before adding).

## 4. BLOCKED

**Nothing blocked this sprint.** The items below are the (expected) live-mode setup that only you can do.

## 5. LIVE-SWITCH CHECKLIST (fixtures → real, ~15 minutes, zero code changes)

**A. Supabase (~7 min)**
1. supabase.com → New project (name `rapidforge`, region us-west, save the DB password).
2. SQL Editor → paste + run, **in order**: `supabase/migrations/0001_tenancy.sql`, `0002_domain.sql`, `0003_operational.sql`, `0004_rls.sql`.
3. Authentication → URL Configuration → Site URL: `http://localhost:5173`.
4. (Optional now, needed for Google sign-in later: Authentication → Providers → Google. Magic link works out of the box.)
5. Project Settings → API → copy three values:
   - **Project URL** → `apps/web/.env` `VITE_SUPABASE_URL` **and** `apps/worker/.env` `SUPABASE_URL`
   - **anon public key** → `apps/web/.env` `VITE_SUPABASE_ANON_KEY`
   - **service_role key** → `apps/worker/.env` `SUPABASE_SERVICE_ROLE_KEY` (worker only — never web, never `VITE_`)

**B. Google Cloud (~6 min)**
6. console.cloud.google.com → New project `rapidforge` → APIs & Services → Enable **Places API (New)** (and **PageSpeed Insights API** while you're there — Sprint 3 needs it).
7. Credentials → Create API key → restrict it to Places API (New) → `apps/worker/.env` `GOOGLE_PLACES_API_KEY`.
8. Second key restricted to PageSpeed Insights → `apps/worker/.env` `PAGESPEED_API_KEY`.
9. Billing must be enabled for Places (the $200/mo credit covers solo use; set a budget alert at $50).

**C. Flip and verify (~2 min)**
10. Copy `apps/web/.env.example` → `apps/web/.env` and `apps/worker/.env.example` → `apps/worker/.env`; fill the values above. `WORKER_PORT=8788` stays.
11. `npm run dev` → worker logs must now say `[store] mode: supabase` and `[places] mode: google`.
12. Sign in with a magic link (first sign-in auto-creates your workspace via `bootstrap_workspace`).
13. New Search → plumber · your zip · 10 mi → real businesses stream in; check `usage_events` rows in the Supabase Table Editor.

Rollback at any point: delete the two `.env` files → fixture mode returns.

## 6. Notes for Joey

- Untracked files `CLAUDE_1.md`, `RapidForge-PRD_1.md`, and `PRD/*.docx` are sitting in the repo root (your copies — I didn't touch them). If they're scratch, delete them or I can gitignore `PRD/` next session.
- Nothing was pushed. 9 local commits on `main` await your go.
- The searches table now sees statuses `pending → scouting → auditing → completed | failed` — worth knowing when you read rows in the Supabase editor.

## 7. Recommended Sprint 3 prompt

```
Prompt S3 — RapidForge Sprint 3 (Audit Agents + Scorer) — AUTONOMOUS SESSION MODE

Autonomous Session Mode is GRANTED per CLAUDE.md Section 12. Read CLAUDE.md and
RapidForge-PRD.md Sections 4, 6.3–6.7, and 11 (Sprint 3), then execute end-to-end.

SAME MODIFIED CONSTRAINT AS SPRINT 2: I may not have env keys yet. Extend the
swappable-seam pattern: a PsiClient interface (real PageSpeed Insights vs fixture
returning realistic Lighthouse/CrUX payloads per fixture business) and an
HtmlFetcher interface (real homepage fetch vs fixture HTML per business covering
platform fingerprints, tel: links, forms, booking widgets, viewport/schema, stale
copyright years). Fixture mode must exercise every scorer path.

Build per PRD Sprint 3: Health (PSI desktop+mobile, SSL, platform detection,
copyright year), Conversion (HTML parse), Presence (Place Details depth), Traffic
(CrUX flag from the PSI response), deterministic Scorer replacing Sprint 2's
provisional pending audits with real health/stars/sellability/issues, the
lead.scored event, 5-concurrent fan-out, agent_runs + usage_events (pagespeed_call)
rows. Sonnet summary calls go through RapidForge AI Core ONLY behind an AiCore
interface with a fixture implementation, so the pipeline runs without
ANTHROPIC_API_KEY (persist summaries as null + guardrail note in fixture mode).

Unit tests: platform fingerprints, health-score inputs from fixture PSI/HTML,
scorer integration (dead site 10, builder platforms low, issues list thresholds),
provisional→real audit replacement.

ACCEPTANCE (no env vars): tsc clean; all tests pass; npm run dev → re-run the
fixture search → every 'Audit pending' lead re-scores with real deterministic
health/stars/sellability + issues; dead site stays 10/92; hot leads stay 95;
agent_runs rows exist for health/conversion/presence/traffic/scorer.

HARD LIMITS unchanged. EXIT: SESSION_REPORT.md with acceptance output and an
updated live-switch note (PAGESPEED_API_KEY + ANTHROPIC_API_KEY).
```

---

*Session executed by Claude Code (Fable 5) under CLAUDE.md v1.2 — Sprint 2, 2026-07-04.*
