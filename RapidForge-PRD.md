# RapidForge — Product Requirements Document (v2.1)

**Owner:** Joey Colley | RapidForgeAI
**Version:** 2.1 (merges PRD v2.0 architecture with v1.1 model/AI corrections)
**Last updated:** 2026-07-04
**Status:** Ready for Sprint 1

**What changed in v2.1:** restored the v2.0 deterministic scoring system (Health + Sellability), no-website hot-lead handling, multi-tenant schema, jobs queue, Realtime dashboard, platform detection, CrUX traffic proxy, and sprint gating with acceptance tests. Layered in from v1.1: current model lineup (Fable 5 / Sonnet 4.6 / Haiku 4.5 — "Opus 4.7" and "GPT-5.5" are not real model IDs), Fable 5 refusal→Opus 4.8 fallback, all AI calls through RapidForge AI Core, LLM prompt specs with self-check guardrails, cascading variables, and the Sales Summary (talk track) agent, which v2.0 lacked entirely.

---

## 0. How to use this document with Claude Code

- This PRD + `CLAUDE.md` live in the repo root. Claude Code loads CLAUDE.md automatically; consult this PRD before building anything.
- Work Section 11 sprints in order. Do not start sprint N+1 until sprint N passes its acceptance test.
- Supervised sessions: plan mode first, one step at a time. Autonomous sessions: only when Joey's kickoff prompt explicitly grants Autonomous Session Mode (CLAUDE.md Section 12) — then run the whole sprint end-to-end, commit locally, never push, and finish with `SESSION_REPORT.md`.
- SQL is never executed by Claude Code. Write migration files; Joey pastes them into the Supabase web SQL editor.

---

## 1. Executive summary

RapidForge is a multi-agent platform for finding local service businesses with underperforming (or missing) websites and converting them into paying clients for website rebuilds and adjacent services.

v1 is a single-user internal tool for Joey: run searches, review ranked leads, make sales calls, close website deals. The architecture is multi-tenant from day one so v2 can become a true SaaS without a rewrite.

The differentiator is a crew of specialized agents — each measuring one dimension of a target business — with a real-time mission-control dashboard showing them work live (also a powerful demo for @buildaiwithjoey content).

**Primary outcome.** Input: zip code, map area, or natural-language query + category. Output: a ranked list of leads with specific issues flagged, a 1–5 star website grade, a Sellability Score, a plain-English "what's wrong" summary, a 60-second cold-call talk track, and a Claude Code–ready Builder Brief for the replacement site.

---

## 2. Goals and non-goals

### 2.1 In scope for v1 (Sprints 1–5)
- Multi-tenant foundation: workspaces, members, plans (stub "Founder" plan), RLS, usage metering.
- Zip/radius search (map-draw and keyword modes in Sprint 5/6).
- Operational agents against real APIs: Scout, Filter, Health, Conversion, Presence, Traffic, Scorer.
- Website Health Score (0–100), 1–5 star grade, Sellability Score (0–100) per lead.
- "What's wrong" bullet summary per lead.
- Real-time mission-control dashboard: agent cards, live event stream, results populating live.
- Pipeline tracking (New / Called / Interested / Sold / Dead), kanban, notes, follow-up dates.
- CSV export. Command palette (cmd-K).

### 2.2 In scope for v1.5 (Sprints 6–7)
- Design Agent (Claude vision on screenshots), Reputation Agent, SEO Agent.
- Analyst Agent (Fable 5 narrative synthesis), Builder Brief Agent (Fable 5), Sales Summary Agent (talk track).
- Puppeteer screenshots; PDF audit report (sales collateral); before/after client deliverable.
- Keyword search mode ("HVAC companies in Boise with fewer than 50 reviews") and map-draw mode.

### 2.3 v2 / SaaS launch (later, scope separately)
Stripe billing + tiers, quota enforcement, BYOK Places keys, marketing site, signup/onboarding, teams, integrations (Gmail, Slack, HubSpot, Calendly), outreach drafting agent, Reply Classifier agent, paid traffic/SEO data sources.

### 2.4 Out of scope entirely
Booking agent (future BookForge), AI receptionist (future DeskForge), the client website builds themselves (Claude Code, separate repo per client), email sending/warmup (external tools).

### 2.5 Success metrics for v1
- Full search-to-audit cycle on 50 businesses in under 10 minutes.
- Top-20 leads match Joey's subjective "good lead" judgment ≥80% of the time.
- First website sale closed within 30 days of real use.
- Free-tier API usage holds for solo use (Places $200/mo credit, PSI free, Yelp free).
- Dashboard demos live without embarrassment.

---

## 3. Architecture

### 3.1 Deployment topology
1. **apps/web (Vercel):** Vite + React dashboard. Supabase anon key + RLS only. No secrets. Subscribes to Realtime events.
2. **apps/worker (local Node/Express in v1 → Railway when v1 proves out):** the entire pipeline — Places calls, PSI calls, HTML fetch/parse, Puppeteer, all AI calls via RapidForge AI Core, PDF export. Holds ALL secrets. Runs a Postgres-backed job queue poller. Broadcasts Realtime events with the service-role key.
3. **Supabase:** Postgres (multi-tenant, RLS), Storage (screenshots, PDFs), Auth (email magic link + Google OAuth), Realtime.

Dev runs web + worker together via `concurrently`. npm workspaces monorepo: `apps/web`, `apps/worker`, `packages/shared` (Zod schemas + types used by both sides).

### 3.2 Agent roster

| Agent | Phase | Type | Model | Responsibility |
|---|---|---|---|---|
| Scout | v1 | deterministic | — | Places Nearby Search (New), grid-tiles large areas, Place Details enrichment, dedupe by place_id |
| Filter | v1 | deterministic + LLM edge-pass | Haiku 4.5 (edge cases only) | Pre-audit qualification; routes no-website businesses straight to hot-lead |
| Health | v1 | deterministic + LLM summary | Sonnet 4.6 (summary) | PageSpeed Insights (desktop + mobile), SSL, response time, platform detection |
| Conversion | v1 | deterministic + LLM summary | Sonnet 4.6 | HTML parse: phone/tel:, forms, booking, chat, CTAs, viewport meta |
| Presence | v1 | deterministic + LLM summary | Sonnet 4.6 | GBP depth via Place Details: photos, hours completeness, NAP consistency |
| Traffic | v1 | deterministic | — | CrUX field-data presence from the PSI response = free traffic proxy |
| Scorer | v1 | **deterministic math** | — | Health Score, star grade, Sellability Score, threshold-based issues list |
| Design | v1.5 | LLM (vision) | Sonnet 4.6 | Screenshot modernity scoring, specific visual critique |
| Reputation | v1.5 | deterministic + LLM | Sonnet 4.6 | Google vs. Yelp/BBB/Facebook divergence |
| SEO | v1.5 | deterministic + LLM | Sonnet 4.6 | Schema markup, title/meta/H1, local keywords, sitemap |
| Analyst | v1.5 | LLM synthesis | **Fable 5** → Opus 4.8 fallback | Narrative verdict, top-3 improvements, enriched issues — FROM deterministic data |
| Builder Brief | v1.5 | LLM synthesis | **Fable 5** → Opus 4.8 fallback | Claude Code–ready rebuild prompt |
| Sales Summary | v1.5 | LLM | Sonnet 4.6 | 60-second cold-call talk track + objection handling |
| Keyword Parser | v1.5 | LLM | Sonnet 4.6 | Natural-language search → structured query |

**Design principle: deterministic before AI.** Anything measurable is measured in code and stored as data. LLMs interpret, summarize, critique, and write — they never guess a fact the worker can check.

### 3.3 Orchestration
1. Search created → `searches` row + Scout job enqueued in `jobs`.
2. Scout returns N businesses → orchestrator fans out one audit job per business (rate limit: 5 concurrent).
3. Filter runs first per business. No-website → skip audit, write sellability-95 lead. Fail → mark skipped with reason.
4. Health / Conversion / Presence / Traffic run in parallel (independent). v1.5 adds Design / Reputation / SEO to the same fan-out.
5. Scorer runs deterministically on their outputs → writes `audits` row, scores, issues → emits `lead.scored`.
6. v1.5: Analyst → then Builder Brief + Sales Summary (on demand from the lead drawer, not automatically — saves Fable tokens on leads Joey never pursues).
7. Frontend receives Realtime events and updates live.

### 3.4 Model + AI integration rules
- **All AI calls go through RapidForge AI Core** (`github.com/jcolley2019/rapidforge-ai-core`). App code never imports the Anthropic SDK or calls providers directly.
- Models: `claude-haiku-4-5` (Filter edge-pass, cheap classification), `claude-sonnet-4-6` (audit summaries, Design, Sales Summary, Keyword Parser), `claude-fable-5` (Analyst + Builder Brief only).
- **Fable 5 specifics:** $10/M input, $50/M output. Adaptive thinking always on (`effort` controls depth). Temperature 1.0 or unset. A refusal returns HTTP 200 with `stop_reason: "refusal"` — retry the identical request on `claude-opus-4-8`. Never let a refusal stall a job.
- **Sprint 0 task:** verify RapidForge AI Core supports `claude-fable-5` + refusal fallback; add if missing (raw-fetch adapters, small change). Run its test suite.
- Every AI call logs `tokens_used` + `cost_cents` to `agent_runs` and `usage_events`.

### 3.5 External APIs (all free tier for v1)

| API | Cost | Limit | Use |
|---|---|---|---|
| Google Places (New) | $200/mo credit | plenty solo | Business list + details |
| PageSpeed Insights | Free | 25k/day | Lighthouse + CrUX |
| Yelp Fusion | Free | 5k/day | Reputation cross-reference (v1.5) |
| Google Maps JS | Free tier | 28k loads/mo | Map-draw UI (v1.5) |
| Claude API | usage | — | Via RapidForge AI Core |

Budget target: **under $200/month total** for v1 personal use, dominated by Claude API (~$0.30–0.80 per fully analyzed business once Analyst/Brief run; audit-only is cents).

---

## 4. Scoring system

### 4.1 Website Health Score (0–100, higher = better site)

| Signal | Weight | Measurement |
|---|---|---|
| Performance | 25% | PSI desktop performance score |
| Mobile | 20% | PSI mobile performance score (mobile-heavy weighting: 70%+ of local searches) |
| Technical | 10% | SSL valid, HTTPS enforced, response <2s, viewport meta present |
| Platform | 15% | Wix/GoDaddy Builder=20, Squarespace=45, WordPress=65, Webflow/custom=85 |
| Conversion | 15% | Visible tel: phone, contact form, booking link, CTA above fold, click-to-call |
| Freshness | 10% | Copyright year within 2 years, recent Last-Modified, no broken images |
| Design | 5% | Vision modernity score (stub 50 in v1; real in v1.5) |

### 4.2 Star grade (1–5, derived from Health Score — display + sales narrative)
`>=85 → 5★ · 70–84 → 4★ · 50–69 → 3★ · 30–49 → 2★ · <30 → 1★` (half-stars at band edges optional). 4–5★ = not a sales target.

### 4.3 Sellability Score (0–100, higher = better LEAD)
Surfaces businesses that are successful but have poor websites — money + pain.

| Signal | Weight | Measurement |
|---|---|---|
| Inverted health | 40% | 100 − health score |
| Review count | 20% | 0–4=20, 5–19=50, 20–99=80, 100+=100 |
| Rating quality | 15% | 3.8+ stars = cares about reputation → will care about website |
| Phone reachable | 10% | Phone in Places data = 100, else 0 |
| Not a chain | 10% | is_chain = 0, else 100 |
| Operational | 5% | business_status = OPERATIONAL |

### 4.4 Special cases
- **No website at all:** sellability auto-95, badge "No website — easiest pitch." Health null. Skips audit pipeline entirely.
- **Site times out / errors:** health 10, sellability boost, badge "Site broken — urgent."
- **Builder platform detected:** "Builder site" tag — easiest to replace.

### 4.5 "What's wrong" issues list
Scorer writes threshold-based plain-English bullets, stored as `{severity: 'low'|'medium'|'high', label, detail?}[]` in `audits.issues`. Examples: "Mobile page load is 8.2s (should be under 3)," "No visible phone number above the fold," "Built on GoDaddy Website Builder," "Copyright year is 2019," "Missing schema.org LocalBusiness markup."

Weights live in `packages/shared/scoring.ts` as constants — tune after the first 100 real audits.

---

## 5. Data model (Supabase — multi-tenant from day one)

All SQL applied by Joey in the Supabase web SQL editor. Migration files in `supabase/migrations/` for history. Every domain table carries `workspace_id` with RLS.

### 5.1 Tenancy
```sql
create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,              -- 'founder' | 'free' | 'starter' | 'pro'
  monthly_search_limit int,               -- null = unlimited
  monthly_audit_limit int,
  max_radius_miles int default 25,
  max_results_per_search int default 100,
  price_cents int default 0
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_id uuid references plans(id),
  owner_user_id uuid references auth.users(id),
  places_api_key text,                    -- BYOK, null = platform key (v2)
  created_at timestamptz default now()
);

create table workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',    -- owner | admin | member
  created_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

-- Cascading agent variables, per workspace
create table workspace_config (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  your_offer text,
  target_industry text,
  ideal_website_traits text,
  sales_tone text default 'direct, friendly, peer-to-peer, no-BS',
  user_location text,
  user_brand text default 'RapidForgeAI',
  updated_at timestamptz default now()
);
```

### 5.2 Domain
```sql
create table searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  created_by uuid references auth.users(id) not null,
  mode text not null,                     -- 'zip_radius' | 'map_draw' | 'keyword'
  params jsonb not null,
  category text not null,
  status text default 'pending',
  results_count int default 0,
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  google_place_id text not null,
  name text not null,
  phone text, website_url text, address text,
  lat numeric, lng numeric,
  google_rating numeric, review_count int,
  category text, business_status text,
  is_chain boolean default false,
  website_kind text default 'unknown',    -- 'real' | 'social_only' | 'none' | 'unknown'
  first_seen_at timestamptz default now(),
  last_refreshed_at timestamptz default now(),
  unique(workspace_id, google_place_id)   -- upsert on conflict
);

create table search_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  search_id uuid references searches(id) on delete cascade not null,
  business_id uuid references businesses(id) not null,
  latest_audit_id uuid,
  status text default 'new',              -- new | called | interested | sold | dead
  notes text, last_contacted_at timestamptz, next_followup_at timestamptz,
  created_at timestamptz default now(),
  unique(search_id, business_id)
);

create table audits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  business_id uuid references businesses(id) on delete cascade not null,
  website_url text,
  ps_performance int, ps_mobile_performance int,
  ps_accessibility int, ps_seo int, ps_best_practices int,
  ps_lcp_ms int, ps_cls numeric,
  http_status int, ssl_valid boolean, response_ms int,
  platform text, copyright_year int,
  has_phone boolean, has_form boolean,
  has_booking boolean, has_chat boolean,
  has_viewport_meta boolean, has_schema_markup boolean,
  gbp_photo_count int, gbp_review_velocity numeric,
  has_crux_data boolean,
  screenshot_desktop_url text, screenshot_mobile_url text,
  website_health_score int, star_grade numeric, sellability_score int,
  score_breakdown jsonb, issues jsonb,
  analyst_output jsonb,                   -- Fable 5 narrative (v1.5)
  builder_brief_md text,                  -- Fable 5 brief (v1.5)
  sales_summary jsonb,                    -- talk track (v1.5)
  status text default 'pending',
  error_message text,
  created_at timestamptz default now(),
  completed_at timestamptz
);
```

### 5.3 Operational
```sql
create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  job_type text not null,                 -- 'scout' | 'audit_business' | 'analyst' | ...
  payload jsonb not null,
  status text default 'queued',           -- queued | running | done | failed
  attempts int default 0,
  error text,
  created_at timestamptz default now(),
  started_at timestamptz, finished_at timestamptz
);
create index on jobs (status, created_at);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  agent_name text not null,
  job_id uuid references jobs(id),
  target_id uuid,                         -- business_id typically
  status text not null,                   -- running | completed | failed
  input jsonb, output jsonb, error text,
  model_used text,
  tokens_used int default 0,
  cost_cents int default 0,
  guardrail_passed boolean default true,
  guardrail_notes text,
  duration_ms int,
  started_at timestamptz default now(),
  ended_at timestamptz
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  event_type text not null,               -- 'places_call' | 'pagespeed_call' | 'ai_call' | 'audit_run'
  cost_cents int default 0,
  metadata jsonb,
  created_at timestamptz default now()
);
create index on usage_events (workspace_id, created_at);
```

### 5.4 RLS
Every domain/operational table: workspace members can select/insert via `workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())`. `plans` world-readable. `workspaces` visible to members. Worker uses service-role key (bypasses RLS) — that key exists ONLY in the worker env.

### 5.5 Caching
If `businesses.last_refreshed_at` is within 30 days and a completed audit exists, reuse it (skip re-audit) unless "Force re-audit" is clicked. Audit history is preserved — `audits` is append-only per run; `search_results.latest_audit_id` points at the newest.

### 5.6 Realtime events
Worker broadcasts on channel `workspace:{id}`:
```ts
type AgentEvent =
  | { type: 'agent.started';   agent: string; target?: string }
  | { type: 'agent.progress';  agent: string; target?: string; message: string }
  | { type: 'agent.completed'; agent: string; target?: string; result: any }
  | { type: 'agent.failed';    agent: string; target?: string; error: string }
  | { type: 'lead.scored';     businessId: string; healthScore: number; sellabilityScore: number };
```
Frontend subscribes on login; agent state also persisted in `agent_runs` so a page reload recovers current status. Polling `GET /api/searches/:id` remains the fallback.

---

## 6. Agent specifications

> **Cross-agent rules:** deterministic before AI · strict JSON output (Builder Brief outputs markdown) · every claim cites a source (URL, metric name+value, or `"inference"`) · missing data = `"unknown"`, never fabricated · every LLM agent has self-check guardrails (fail → re-run once → save with `guardrail_passed:false` and flag) · cascading `{variables}` come from `workspace_config` via one shared template function.

### 6.1 Scout (deterministic)
Places Nearby Search (New) with type filter; **grid-tile** areas larger than one search's coverage and dedupe by place_id; Place Details enrichment (website, phone, rating, review count, business_status, photos count); is_chain heuristic (brand-name list + multi-location detection); writes `businesses` (upsert on `(workspace_id, google_place_id)`) + `search_results`; logs a `usage_events` row per Places call. Hard cap: `max_results_per_search` from plan (100 Founder).

Website classification (deterministic): `real` | `social_only` (facebook/instagram/yelp/linktree URL) | `none`.

### 6.2 Filter (deterministic + Haiku edge-pass)
Deterministic checks first: business_status OPERATIONAL; review count ≥ min_reviews param; rating ≥ min_rating param; is_chain exclusion (configurable).
- `website_kind = 'none'` → **do not skip**: create lead with sellability 95, badge "No website — easiest pitch," bypass audit pipeline.
- `website_kind = 'social_only'` → same treatment, badge "Social-only presence."
- `website_kind = 'real'` → worker HEAD-checks the URL. Dead/parked → audit with health 10, badge "Site broken — urgent."

Haiku edge-pass ONLY for ambiguity (suspicious/spam name, enterprise CMS fingerprint suggesting they already pay an agency):
```
SYSTEM: You are a lead-qualification edge-case checker for a website
improvement service. Output strict JSON only.
USER: {business_json with ambiguity flags}
Return: { "pass": boolean, "reason": string (one specific sentence), "confidence": 0-100 }
```
Guardrails: reject generic reasons ("looks fine"); confidence <60 → pass:false.

### 6.3 Health (deterministic + Sonnet summary)
Worker calls PSI (`/pagespeedonline/v5/runPagespeed`) for mobile AND desktop; extracts category scores, LCP, CLS, TBT; checks SSL/HTTPS/response time itself; detects platform by HTML/header fingerprints (Wix, GoDaddy, Squarespace, WordPress, Webflow, custom); extracts copyright year.
Sonnet writes the interpretation:
```
SYSTEM: You are a web performance analyst. Cite specific metric values
("LCP of 5.8s exceeds the 2.5s good threshold") — never vague. Strict JSON.
USER: {metrics_json}
Return: { "reasoning": string (3-5 sentences, ≥2 numeric values),
  "critical_issues": [{"issue","metric","value"}], "summary_one_liner": string }
```
Guardrails: reject if reasoning has <2 numeric values; reject empty critical_issues when performance <50.

### 6.4 Conversion (deterministic + Sonnet summary)
Worker fetches homepage HTML; deterministically detects: `tel:` links, forms + field counts, booking links (calendly/cal.com/square/etc.), chat widgets, viewport meta, schema markup presence, CTA candidates above fold. Sonnet evaluates CTA strength and writes the narrative with exact quoted element text as evidence. Guardrails: reject "general impression" evidence; reject cta found=true with null text.

### 6.5 Presence (deterministic + Sonnet summary)
Place Details: GBP photo count, hours completeness, review response proxy. NAP comparison website-vs-Places (deterministic string compare with normalization; Sonnet only adjudicates near-misses). Guardrails: reject nap_consistent=true without compared values; reject social platforms not present in HTML.

### 6.6 Traffic (deterministic, v1 — free)
From the already-fetched PSI response: CrUX field data present → real-user traffic exists; absent → very low traffic (sellability-relevant signal). No extra API call. `has_crux_data` on the audit.

### 6.7 Scorer (deterministic — no LLM)
Pure functions in `packages/shared/scoring.ts`: Health Score per 4.1, star grade per 4.2, Sellability per 4.3, special cases per 4.4, issues per 4.5. Writes the audit row, emits `lead.scored`.

### 6.8 Design (v1.5, Sonnet vision)
Inputs: Puppeteer desktop (1440px) + mobile (390px) screenshots.
```
SYSTEM: You are a senior visual designer evaluating small business websites.
Evaluate typography, color, imagery, layout, mobile, modern feel. Be SPECIFIC —
"Looks unprofessional" is unacceptable; "hero uses Comic Sans in #FF00FF on a
clipart background" is acceptable. Reference actual visible elements. Honest,
not cruel. Strict JSON.
USER: {url} + desktop screenshot + mobile screenshot
Return: { "modernity_0_100": int, per-dimension {score, notes},
  "feels_like_year": int, "reasoning": string,
  "critical_issues": [{"issue","evidence"}] }
```
Guardrails: reject sub-score notes <15 words; reject feels_like_year>2024 with modernity<70; reject empty critical_issues with modernity<70. Feeds the 5% Design weight (replacing the stub 50).

### 6.9 Reputation (v1.5, deterministic + Sonnet)
Yelp Fusion + BBB + Facebook cross-reference vs. Google rating; divergence flags; theme extraction from available reviews (quotes <15 words). Guardrails: reject overlong quotes; reject volume "high" under 50 reviews.

### 6.10 SEO (v1.5, deterministic + Sonnet)
Worker checks sitemap.xml/robots.txt, extracts title/meta/H1s/schema types deterministically; Sonnet evaluates quality + local keyword presence for `{city} + {category}`. Guardrails: reject found=true with null value; reject score 5 with missing title/meta/H1.

### 6.11 Analyst (v1.5, **Fable 5** → Opus 4.8 fallback)
The narrative synthesis layer on top of deterministic scores. Runs automatically after Scorer for leads with sellability ≥ 60 (config), on demand otherwise.
```
SYSTEM: You are a senior consultant synthesizing a website audit into an
executive verdict for a salesperson. You are given measured data and computed
scores — do not re-score; explain and prioritize. Cite specific findings by
agent and value. Strict JSON.
USER: {all agent outputs + scores + issues} for {business_name}
Return: {
  "verdict": "actively_losing_business"|"needs_rebuild"|"needs_improvement"|"solid"|"excellent",
  "sales_lead_priority": "hot"|"warm"|"skip",
  "top_3_improvements": [{priority, improvement, rationale, estimated_impact}],
  "reasoning": string (5-8 sentences citing ≥3 agents by name),
  "one_line_verdict": string (≤20 words)
}
```
Guardrails: reject <3 improvements; reject reasoning citing <3 agents; reject one-liner >20 words; reject verdict inconsistent with star grade (e.g., "excellent" with 2★).

### 6.12 Builder Brief (v1.5, **Fable 5** → Opus 4.8 fallback, markdown output)
Inputs: full audit + screenshots + existing-site HTML content + GBP data + top-3 local competitors (pulled fresh at brief time) + target keywords.
Output: paste-ready markdown per this structure — Project overview · Business details · Target audience · Pages to build with per-page content outline (H1s, sections, CTAs) · Design direction (palette, type, vibe, reference sites) · SEO requirements (per-page titles/metas, LocalBusiness + Service + FAQPage schema, canonicals, alt text, internal linking) · **AEO requirements** (FAQ as direct Q-A pairs, entity definitions, structured data for AI citations) · Conversion requirements (sticky click-to-call header, booking embed, ≤3-field form, trust bar, review carousel) · Performance requirements (Lighthouse mobile >90, LCP <2.5s, CLS <0.1, WebP, lazy load) · Content to migrate (with rewrite notes) · Assets (hero image prompt, icons) · Deploy instructions.
Client-site stack: Vite or Next.js per client need + Tailwind + shadcn/ui (Joey's call per project; brief states one).
Guardrails: reject placeholders (`[INSERT NAME]`, `{business_name}`); reject missing sections; reject >2000 words.

### 6.13 Sales Summary (v1.5, Sonnet — NEW vs. PRD v2.0)
```
SYSTEM: You write cold call talk tracks for a website improvement consultant.
~60 seconds to earn permission to keep talking. Voice: {sales_tone}.
Open with a SPECIFIC audit observation. One concrete problem + business impact.
Offer something tangible (free mockup / 5-min walkthrough). Soft close asking
permission, not a meeting. ≤150 words spoken. Banned: synergy, leverage,
unlock, empower, circle back, touch base, deep dive. No fake compliments.
Strict JSON.
USER: {business_name} + audit + analyst output
Return: { "opener"(≤30w), "earned_observation"(≤40w), "pain_hypothesis"(≤30w),
  "offer"(≤30w), "soft_close"(≤20w), "full_talk_track"(≤150w),
  "anticipated_objections": [{objection, response}] (2-3) }
```
Guardrails: reject non-specific earned_observation; reject >150 words; reject banned words; reject <2 objections.

### 6.14 Keyword Parser (v1.5, Sonnet)
Parses "wedding photographers in Scottsdale under $3k" into structured search params; parsed params shown to the user for confirmation before running.

---

## 7. Dashboard specification

### 7.1 Visual language
Dark default (light toggle). Electric cyan `#00d9ff` for agent-active; amber waiting, green complete, red errors. JetBrains Mono for data/logs/numbers, Inter for chrome. Subtle motion: agents pulse while working, leads slide in when scored, counters tick. Dense grid layout, 6–8px radii, 1px low-opacity borders.

### 7.2 Layout
Top bar (workspace switcher, cmd-K hint, usage meter, account) · left rail (Pipeline, New Search, Leads, Agents, Analytics, Settings) · main area · right drawer (lead detail, 560px).

### 7.3 Views
- **Pipeline (default):** kanban New/Called/Interested/Sold/Dead; drag-drop updates status; cards show name, sellability badge, phone, last action; filter bar.
- **New Search:** tabs Zip/Radius (zip, radius slider 1–25 + presets, searchable category picker, min reviews, min rating) · Map Draw (v1.5) · Keyword (v1.5, shows parsed params before run). Shows estimated cost + expected result count. Recent searches below.
- **Live Search:** params strip + elapsed + cancel; agent grid cards (status pulse, current task, done/queued, avg runtime); terminal-style event stream (filterable by agent); results table populating live sorted by sellability desc; auto-transition to Lead List when idle.
- **Lead List:** sortable/filterable table — name, phone, domain, rating, reviews, platform badge, health, stars, sellability (colored), status, last action. Filters: has/no website, platform, status, score ranges. Bulk: CSV export, status update, re-audit.
- **Agents:** per-agent lifetime stats (runs, success rate, avg runtime, cost), enable/disable toggles, weight/threshold config, live log tail.
- **Analytics (minimal v1):** usage meters, funnel (generated→called→interested→sold), platform distribution, avg health by category.
- **Settings:** workspace, cascading variables (workspace_config), agent toggles/weights, team stub, integrations "coming soon." API keys are NOT here — worker env only.

### 7.4 Lead detail drawer
Tabs: Overview (status dropdown, sellability badge, star grade, "what's wrong" bullets, key signals) · Screenshots · Audit (raw per-agent data, expandable) · Builder Brief (v1.5: generate/copy/regenerate) · Sales Script (v1.5: talk track + objections, copy) · History (all audits, timeline) · Notes (auto-saved).

### 7.5 Command palette (cmd-K)
Jump to lead, new search, switch workspace, go to view, toggle theme, export CSV, trigger re-audit, open settings section.

---

## 8. API contracts (worker HTTP, Supabase JWT required)

- `POST /api/searches` — body varies by mode (`zip_radius` | `map_draw` | `keyword`); returns `{search_id, status:'queued'}`.
- `GET /api/searches/:id` — search + paginated leads + `agent_states` (polling fallback).
- `POST /api/leads/:id/status` — `{status, notes?, next_followup_at?}`.
- `POST /api/businesses/:id/reaudit` — enqueue fresh audit; returns `{job_id}`.
- `POST /api/businesses/:id/analyst` · `POST /api/businesses/:id/builder-brief` · `POST /api/businesses/:id/sales-summary` (v1.5, on-demand Fable/Sonnet runs).
- `GET /api/agents` — lifetime stats. `GET /api/usage` — current-month breakdown.

---

## 9. Secrets management

- **Frontend (Vercel env):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GOOGLE_MAPS_BROWSER_KEY` (v1.5, referrer-restricted). Only browser-safe values ever get the `VITE_` prefix.
- **Worker (.env local → Railway env):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_PLACES_API_KEY`, `PAGESPEED_API_KEY`, `YELP_API_KEY` (v1.5), `ANTHROPIC_API_KEY`, `WORKER_PORT=8788`.
- Never expose: service-role key, server Places key, PSI key, Anthropic key.

---

## 10. Working rules (see CLAUDE.md for the enforced full set)

Read before write · plan mode for non-trivial changes (supervised sessions) · one problem per commit · surgical fixes · `npx tsc --noEmit` in both apps before commit · never push without Joey's go · SQL only via migration files Joey pastes into the Supabase web editor · protected files per CLAUDE.md · Autonomous Session Mode only when explicitly granted in the kickoff prompt.

---

## 11. Sprint plan (work in order; gate on acceptance)

### Sprint 0 — AI Core readiness (½ session, in the rapidforge-ai-core repo)
Verify/add `claude-fable-5` support + `stop_reason:"refusal"` → `claude-opus-4-8` fallback + cost/token reporting. Tests pass (existing 59 + new fallback tests).
**Acceptance:** a test call specifying fable-5 succeeds; a simulated refusal retries on opus-4-8; tokens+cost returned.

### Sprint 1 — Foundation (autonomous-capable)
- npm-workspaces monorepo: `apps/web` (Vite+React+TS+Tailwind+shadcn, dark shell: top bar, left rail, view stubs), `apps/worker` (Express `/health`, jobs poller skeleton that no-ops without env), `packages/shared` (Zod schemas, scoring constants, AgentEvent types).
- Migration files `0001_tenancy.sql`, `0002_domain.sql`, `0003_operational.sql`, `0004_rls.sql` per Section 5 (written, NOT applied).
- `.env.example` both apps per Section 9. `.gitignore`. README. `concurrently` dev script.
- Auth pages (magic link + Google OAuth) wired to Supabase client — functional once Joey supplies env.
- First-signup bootstrap: auto-create workspace + owner member + Founder plan row.
**Acceptance:** `npx tsc --noEmit` clean in web, worker, shared; `npm run dev` starts both; migration SQL reviewed; SESSION_REPORT.md written if run autonomously.

### Sprint 2 — Scout + search flow
Places (New) integration with grid tiling, dedupe, filters, is_chain, website_kind classification; orchestrator `POST /api/searches`; Postgres job poller (2s); New Search zip/radius form; Live view polling; results table; usage_events per Places call.
**Acceptance:** "plumber, 83704, 10mi" → 20–50 businesses with name/phone/rating/reviews within 60s; usage_events rows exist; no keys in browser.

### Sprint 3 — Audit agents + Scorer
Health (PSI both strategies + SSL + platform + copyright year), Conversion (HTML parse + Sonnet summary), Presence, Traffic (CrUX flag), Filter routing (incl. no-website hot leads), deterministic Scorer + stars + sellability + issues; fan-out orchestration (5 concurrent); agent_runs rows; live score updates.
**Acceptance:** same search fully scored <10 min; top-5 sellability leads subjectively correct; no-website businesses appear as sellability-95 leads; graceful handling of dead sites; agent_runs + usage_events populated.

### Sprint 4 — Realtime dashboard
Worker broadcasts AgentEvents; web subscribes per workspace; agent grid with pulses; live event stream with filters; results table live-updates on `lead.scored`; state recovery from agent_runs on reload.
**Acceptance:** second browser window shows agents working live without refresh; no flicker.

### Sprint 5 — Lead detail, pipeline, polish
Lead drawer (Overview/Audit/History/Notes; Screenshots placeholder); status persistence; kanban drag-drop; full Lead List with bulk CSV; cmd-K; usage meter; Settings incl. cascading variables; keyboard/a11y pass.
**Acceptance:** 3 real searches worked through kanban; CSV export; demo-ready.

### Sprint 6 — v1.5 agents, part 1
Puppeteer screenshots → Storage; Design agent (vision) replacing stub weight; Reputation (Yelp/BBB/FB); SEO agent; new issues surface in "what's wrong"; screenshots tab live.
**Acceptance:** dated Wix site gets specific Design critique; schema-missing site flagged by SEO; reputation divergence flagged.

### Sprint 7 — v1.5 agents, part 2 (the money features)
Analyst (Fable 5 + fallback); Builder Brief (Fable 5); Sales Summary; PDF audit report (2-page sales collateral, worker Puppeteer render); before/after client deliverable; keyword search mode; map-draw mode; Analytics funnel.
**Acceptance:** Builder Brief pasted into Claude Code scaffolds a site addressing every brief item; talk track reads naturally aloud in ≤60s; PDF presentable as-is.

### Sprint 8+ — SaaS launch
Scope separately when Sprints 1–7 produce revenue: Stripe, tiers/quotas, BYOK, marketing site, onboarding, teams, integrations, Reply Classifier agent. Build on paying demand signal, not before.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scope creep | Strict sprint gating; v1.5 agents wait until v1 produces real leads |
| Places cost at scale | $200 credit + 30-day caching + Cloud spend alerts |
| Puppeteer unreliability | Adequate memory locally/Railway; fallback ScreenshotOne (~$17/mo) if it keeps failing |
| Bad early rankings | Joey reviews first 100 leads, tunes weights (constants in shared/scoring.ts) |
| Places ToS for SaaS | v1 internal = fine; v2 BYOK on paid tiers; never resell raw Places data |
| Fable 5 refusals/availability | Automatic Opus 4.8 fallback in AI Core; pipeline never stalls |
| Worker cold starts | Persistent process (local/Railway), health checks |
| OneDrive sync corruption | Repo lives at `C:\dev\rapidforge`, outside OneDrive |

---

## 13. Resolved decisions
Radius: slider 1–25mi + presets · Category: searchable dropdown + presets (+ keyword mode v1.5) · Concurrency: 5 businesses parallel · Cache: 30 days + force re-audit · Tone: "direct, friendly, peer-to-peer, no-BS" · Scoring: deterministic math, LLM narrative · Stars derived from Health per 4.2 · No-website = hot lead, never skipped · Analyst auto-runs at sellability ≥60; Brief + Sales Summary on demand.

## 14. Glossary
AEO (Answer Engine Optimization) · BYOK · CrUX (Chrome UX Report — free real-user data via PSI) · GBP (Google Business Profile) · NAP (Name/Address/Phone consistency) · Place ID · RLS · Sellability Score (lead-priority metric: website badness × business success × reachability).

---

**END PRD v2.1**
