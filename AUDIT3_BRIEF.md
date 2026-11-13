# RFL.AUDIT.3 — operating audit, read-only (2026-11-13)

Goal: confirm rapidforge-leads is operating properly, hosted and in code, after 74 commits since the last audit (docs/AUDIT-2026-10-07.md, head 569b8a8). Read-only: the only files you add are docs/AUDIT-2026-11-13.md and apps/worker/scripts/audit3-probe.ts. No fixes, no migrations, no browser, never read or print .env or any key value. Real-spend cap $0.25 total.

Starting state (checked by the architect today): main = 796b376. Railway is now on the Hobby plan and redeployed 796b376 at 2026-11-13 00:02Z, status SUCCESS. Web https://app.rapidforgeai.com (Vercel). Worker https://rapidforgeworker-production.up.railway.app. Expected tests: shared 93 / worker 616 / web 127.

## Part 0 — Baseline
Typecheck in all three workspaces, the three test suites (counts; must be hermetic), `npm audit --omit=dev` (high/critical only), git status.

## Part 1 — Hosted probes (curl, no sign-in)
- Worker /health: status, the modes it reports (ai / store / places / psi), uptime.
- CORS preflight from https://app.rapidforgeai.com is allowed; from https://evil.example gets no allow-origin header.
- Without a token, and again with a garbage Bearer token: GET /api/leads, POST /api/searches, DELETE /api/searches/<random uuid>, DELETE /api/workspace/data. Every one must answer 401/403 — never 200 and never 500.
- Web: 200 for / and for a deep link (/leads, SPA rewrite). The built JS must contain no `sk-ant-`, no service-role JWT and no server Places key (the Maps browser key is expected there).

## Part 2 — Keys and upstreams (apps/worker/scripts/audit3-probe.ts; worker env through dotenv; values never printed)
One PASS/FAIL line each, with the upstream's own error text on a failure:
- Anthropic: list models and confirm every model ID constant in apps/worker/src/lib/ai.ts is still offered; then one tiny Haiku call through lib/ai.ts.
- Google Places: one searchText, maxResultCount 1 ("plumber Nampa ID"). Proves key and billing (billing was past due on Oct 24).
- PageSpeed: one mobile run on https://example.com.
- Supabase: service-role select; schema_migrations lists 0001–0011; functions delete_search and clear_workspace_data exist and anon/authenticated cannot execute them.
The local .env and Railway hold different Anthropic keys: this part proves the local one, Part 3 proves the hosted one.

## Part 3 — Data health (read-only selects)
- Counts of searches, businesses, audits, by status.
- Stuck work: searches or jobs still running/queued after more than one hour.
- agent_runs since 2026-10-25, per agent: runs, failures, guardrail failures, template fallbacks (model_used null), models used, cost. Quote any upstream 401/403/429/5xx error text.
- Newest row per agent with its timestamp: is the hosted worker actually producing AI output?
- workspace_config: which of offer, location, industry, traits, brand, tone are empty (names only, no values).
- usage_events: spend by endpoint for the last 30 days; any endpoint missing from the cost table in docs/HOW-IT-WORKS.md.

## Part 4 — Code audit of what changed since 569b8a8
Use your judgment. The worker is public now, so these are the areas with real risk:
1. Sign-in and authorization in apps/worker/src/http.ts, route by route: how the JWT is verified, whether workspace membership is enforced, any route that trusts a client-supplied workspace or business id. Who can sign up: is Google sign-in open to anyone, and does a stranger get a workspace that can run paid searches and AI runs on Joey's keys? Any rate limit or spend ceiling?
2. RLS: what the public anon key can read or write through PostgREST. Walk supabase/migrations for policies; flag any table with RLS off or a permissive policy.
3. Delete path (RFL.DATA.1, migration 0011): the orphan rule against how businesses are deduped across searches; whether the jobs/agent_runs keys it filters on match what the worker actually writes; Storage screenshots left behind; clear-all while a search is running.
4. Text Search path (RFL.SEARCH.CAT.2): rectangle restriction against the radius filter, tile dedupe, result caps, cost accounting; the free phrase flowing into Filter, chains, SEO categoryPattern, the Design Brief vertical and the Builder Brief / Sales Summary prompts (prompt injection through a typed phrase or through scraped site text).
5. PSI N-run merge and the partial path (RFL.PSI.1, 1.1): timers, usage logging, cache interaction.
6. Model lineup (RFL.AI.10): defaults, refusal fallback, guardrails/text.ts coverage, retries and timeouts inside the 120 s on-demand route limit.
7. Hosting: Dockerfile, railway.json, healthcheck, Puppeteer memory on Hobby, shutdown in the middle of an audit, in-memory state lost on redeploy (job queue, demo log).
8. Known open items, confirm each: the Min reviews input cannot be typed into (SearchFilterControls); Build demo answers 503 hosted; the submit hint says "Category:" for chips that now route to Text Search.
9. Docs drift: CLAUDE.md, docs/HOW-IT-WORKS.md, docs/DEPLOY.md (still says free trial) and the Help page against the code.

## Part 5 — The audit doc
docs/AUDIT-2026-11-13.md, same evidence standard as AUDIT-2026-10-07: every claim carries a file:line, a printed probe value or a row id. Sections: Verdict (one paragraph: operating properly — yes, no, or yes with caveats); Probe table; Data health; Findings ranked P0 (broken or exposed now), P1 (will bite), P2 (polish), each with evidence and a 2–4 line fix sketch as a brick stub (RFL.AREA.N id, files, size S/M/L); Docs corrections. No padding: a clean area gets one line.
One commit, explicit paths (the doc, the probe script, this brief): docs: operating audit 2026-11-13 + probe script (RFL.AUDIT.3). Push.

## Report
Print between the lines "=== REPORT — RFL.AUDIT.3 ===" and "=== END REPORT ===": the verdict line; the probe table (PASS/FAIL); counts of P0/P1/P2; every P0 and the top five P1s, one line each; test counts; spend; commit sha. Under 60 lines. Do not paste the doc.
