# RFL.DEMO.1 — "Build demo" button: leads → rapidforge-demos, one click

Goal: in the lead drawer, a Demo tab with one button. Clicking it generates the design brief if missing, builds and deploys the prospect's demo site with the rapidforge-demos repo on this machine, shows live progress, and saves the resulting links on the business. Joey never touches a terminal.

Joey has already run this SQL on the Supabase project (do not write a migration that re-adds it; DO add a migration file supabase/migrations/0010_business_demo.sql with the same statements using `add column if not exists`, so the repo matches):
businesses.demo_status text (building|ready|failed), demo_url text, demo_preview_url text, demo_sub text, demo_built_at timestamptz, demo_error text.

## The demos side (already built — do not modify C:\dev\rapidforge-demos)
`npm run demo -- --lead <businessId> [--as <sub>] [--edit]` run with cwd = the demos repo. It reads the brief straight from this Supabase project (service-role key in its own .env), intakes the prospect site, builds, deploys to Vercel, aliases <sub>.demos.rapidforge.ai. Progress goes to stderr (lines starting with "▸ " are steps). The LAST stdout line is JSON: success {"ok":true,"businessId","slug","sub","previewUrl","aliasUrl","aliasOk":bool,"durationMs"}; failure {"ok":false,"stage":"brief|intake|build|previews|deploy|alias","error"} with exit 1. Typical run: 60–120 s. aliasOk is false until DNS is set up — that is NOT a failure; store aliasUrl anyway and mark ready.

## Worker (apps/worker)
1. Env: DEMOS_DIR in apps/worker/.env (set it to C:\dev\rapidforge-demos now) and .env.example with a comment. If unset, the route returns 503 {error:"DEMOS_DIR not configured"}.
2. Refactor: pull the body of POST /api/businesses/:id/design-brief (http.ts ~line 578) into ensureDesignBrief({ business, auth, force }) returning the stored brief or running the agent — the route keeps its behaviour; the demo route reuses it so a lead with no brief gets one first.
3. POST /api/businesses/:id/demo (JWT like every /api route; 404 if business not in auth.workspaceId; 409 if demo_status is already "building"; 409 "No completed audit" if ensureDesignBrief has nothing to work from). Body optional {sub?: string}. It responds 202 {status:"building"} immediately, then in the background: set demo_status=building, demo_error=null; spawn `npm run demo -- --lead <id> [--as sub]` with cwd=DEMOS_DIR (on win32 spawn "npm.cmd" or use shell:true — test on this Windows machine), 10-minute timeout, kill on timeout; forward each stderr line as an AgentEvent on the workspace channel (events.ts — add a minimal event kind for demo logs if the AgentEvent schema in packages/shared needs it; keep the schema change additive and typed); parse the final stdout JSON line; on ok:true set demo_status=ready, demo_url=aliasUrl, demo_preview_url=previewUrl, demo_sub=sub, demo_built_at=now(); on ok:false or non-zero exit set demo_status=failed, demo_error=<stage: error or last stderr line>. One build per business at a time (in-memory lock keyed by business id).
4. GET /api/businesses/:id/demo → the six demo_* fields plus the last 50 log lines kept in memory for a running/just-finished build (so a reload mid-build still shows progress).
5. Store: add updateBusiness(id, patch) to store/types.ts, store/supabase.ts, store/memory.ts; add the six fields to the Business type in packages/shared (optional/nullable).
6. Tests (http.test.ts pattern, spawn injected as a fake process emitting stderr lines then a stdout JSON line): 202 then ready with fields saved; failure JSON → failed with demo_error; non-zero exit without JSON → failed; second POST while building → 409; DEMOS_DIR unset → 503; the brief gets generated first when missing (ensureDesignBrief called).

## Web (apps/web)
7. lib/api.ts: buildDemo(businessId, sub?) → POST; fetchDemoStatus(businessId) → GET.
8. LeadDrawer.tsx: add { key: "demo", label: "Demo" } right after "Design Brief" and a DemoTab component (follow DesignBriefTab's structure and styling). States: no demo yet → explanation line + "Build demo" button (optional sub text input prefilled from the business name's first DNS-safe word); building → spinner, "Building…" and a live log panel fed by realtime demo events (useWorkspaceLive / realtime.ts) with a 3 s poll of GET as fallback; ready → the public link (demo_url) big with Open and Copy buttons, the preview link small underneath labelled "preview (Vercel login)", built-at time, and a "Rebuild" button; failed → the error and a "Try again" button. If aliasOk was false the ready state shows a one-line note "public link goes live once DNS is set up".
9. Leads list row: when demo_url is set, show a small "Demo" link chip next to the website column that opens demo_url.
10. Tests: DemoTab renders each of the four states from props; api functions hit the right paths.

## Verification (all in the REPORT table)
- Repo gates per CLAUDE.md (typecheck, tests, lint, build) for worker, web and shared.
- Worker and web dev servers are ALREADY running in the background from an earlier session — restart only the worker (it needs the new route), reuse web (HMR).
- Live, with Claude in Chrome (Joey approves prompts): open http://localhost:5173 → Leads → All Plumbing & Sewer → Demo tab → Build demo. Confirm: 202, log lines stream in the tab, state flips to ready within ~3 minutes, demo_url = https://allplumbing.demos.rapidforge.ai and demo_preview_url is a vercel.app URL, the Demo chip appears in the list. Then `select demo_status, demo_url, demo_preview_url, demo_built_at from businesses where id='dff84968-ffa0-4188-84e6-079e1556e3e0'` via the store or psql-equivalent and print the row.
- Negative: click Build demo again while building → button disabled / 409 handled without a crash.

Commit on main as "RFL.DEMO.1: Build demo button — worker route, Demo tab, business demo fields" and push. Discard package-lock.json if it shows modified. Print the report between "=== REPORT — RFL.DEMO.1 ===" and "=== END REPORT ===".
