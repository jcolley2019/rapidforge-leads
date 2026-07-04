# SESSION_REPORT — Sprint 1 (Foundation)

**Date:** 2026-07-04 · **Mode:** Autonomous Session Mode (granted in kickoff Prompt S1)
**Scope:** PRD Section 11, Sprint 1 — monorepo, web shell + auth, worker skeleton, shared schemas/scoring, migration files, env examples, README.
**Status: COMPLETE — all acceptance criteria pass. Nothing blocked me mid-sprint; your setup steps are listed under "What Joey must do."**

---

## 0. Where the repo is (read this first)

The session was launched from `C:\Users\jcoll\OneDrive\Desktop\rapidforge-leads`
(kickoff folder with `CLAUDE_1.md` / `RapidForge-PRD_1.md`). CLAUDE.md
Section 1 says the repo lives at **`C:\dev\rapidforge` — NOT under OneDrive**
(OneDrive file-locking breaks `node_modules`). That path existed (only your
`PRD\` docx folder inside), so **the monorepo was built at
`C:\dev\rapidforge`** and git-initialized there. This report lives at the
repo root; a copy was placed in the OneDrive kickoff folder so you'd find it.

- The two kickoff docs were copied **verbatim** into the repo root as
  `CLAUDE.md` and `RapidForge-PRD.md` (source of truth in repo root per
  CLAUDE.md). Not edited in any way.
- Your `PRD\*.docx` folder was left untouched and untracked.
- No git remote configured; **nothing pushed** (per hard limits). Local
  branch: `master`.

## 1. Everything built, by commit

| Commit | What |
|---|---|
| `a6dbe62` chore(repo) | npm-workspaces root (`apps/*`, `packages/*`), `dev` script via concurrently, `.gitignore` (covers `.env*`, keeps `.env.example`) |
| `29fe3e2` docs | CLAUDE.md + RapidForge-PRD.md copied verbatim into repo root |
| `3835aa0` feat(shared) | Zod schemas for all 11 core tables, `AgentEvent` (PRD 5.6 verbatim) + `AgentResult` envelope, `scoring.ts` with every PRD §4 weight/threshold as exported constants + `computeHealthScore` / `deriveStarGrade` / `computeSellabilityScore`, 22 vitest tests incl. all PRD 4.4 special cases |
| `9753f61` feat(db) | `0001_tenancy.sql`, `0002_domain.sql`, `0003_operational.sql` (DDL verbatim from PRD §5), `0004_rls.sql` (policies per PRD 5.4 + `bootstrap_workspace()` RPC). **Written only — nothing executed anywhere** |
| `b924ad0` feat(worker) | Express `/health`, JWT presence-stub middleware on `/api`, 2s jobs-poller skeleton (graceful no-op without env), `orchestrator.ts` / `queue.ts` / `events.ts`, `lib/ai.ts` AI-Core wrapper stub with the 4 model constants + refusal-retry TODO, 14 agent stubs (one per PRD 3.2 row, each TODO-tagged with its PRD §6 section), `agents/prompts/` + `agents/guardrails/` with convention READMEs, `.env.example` per PRD §9 |
| `55f2dea` feat(web) | Vite + React 18.3 + TS strict + Tailwind 3.4 + shadcn-style components; dark default theme with cyan `#00d9ff` primary, Inter + JetBrains Mono (bundled via fontsource); top bar (workspace chip, Ctrl-K hint, usage placeholder, account), collapsible left rail with the 6 PRD 7.2 views as stubs; auth page (magic link + Google OAuth); first-signup bootstrap via `bootstrap_workspace` RPC; offline preview mode when env is absent; `.env.example` |
| `c766f09` docs(readme) | Setup steps + a table of where every env value comes from |
| (this commit) docs | SESSION_REPORT.md |

## 2. Acceptance results (commands run, output recorded)

**1. `npx tsc --noEmit` clean in all three workspaces — PASS**

```
=== shared: npx tsc --noEmit ===   exit: 0
=== worker: npx tsc --noEmit ===   exit: 0
=== web:    npx tsc --noEmit ===   exit: 0
```

**2. vitest on scoring.ts — PASS (22/22)**

```
✓ src/scoring.test.ts (22 tests) 6ms
Test Files  1 passed (1)
Tests       22 passed (22)
```

Covers PRD 4.4: no-website → auto-95 + badge (regardless of other signals);
social-only → identical routing (CLAUDE.md 6.7); dead site → health pinned
to 10 + sellability boost + "Site broken — urgent" badge; builder-platform
tagging; plus star band edges (85/84/70/69/50/49/30/29), review-count bands,
the 3.8 rating threshold, weight-sum integrity, and determinism.

**3. `npm run dev` with no env vars — PASS (no crash, graceful no-op)**

Verified zero `.env` files exist, then:

```
[web]   VITE v5.4.21  ready in 305 ms → http://localhost:5173/
[worker] [queue] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — poller disabled (graceful no-op).
[worker] [worker] listening on http://localhost:8788 (queue: disabled)
```

Probes: `GET http://localhost:8788/health` →
`{"ok":true,"service":"rapidforge-worker","uptime_s":19,"queue":"disabled","poll_interval_ms":2000}`;
web root → HTTP 200, RapidForge title. Web shows the shell in "offline
preview" with an amber banner telling you to fill `.env`.

## 3. Decisions made (and why)

1. **Repo at `C:\dev\rapidforge`** — see §0. If you'd rather work from the
   OneDrive folder, say so and I'll explain the trade-offs before anything moves.
2. **Vite 5, not 6.** vitest 2.x hard-depends on vite 5; two vite majors in
   one npm-workspaces tree caused a TS type clash in `vite.config.ts`.
   Pinned web to `vite ^5.4.21`. Upgrade vite+vitest together later if wanted.
3. **Tailwind 3.4 classic + hand-written shadcn-style primitives** (Button,
   Input, Label, Card, Separator) — no Radix deps yet, keeping Sprint 1 deps
   minimal. `components.json` is in place, so `npx shadcn@latest add <x>`
   works when real components are needed (Sprints 4–5).
4. **No router.** The left rail switches views with local state. React
   Router isn't in the CLAUDE.md §4 fixed stack, and stub views don't
   justify asking. Flagging per the "note it and ask" rule: if you want
   URL-addressable views in Sprint 4–5, that's the moment to add one.
5. **Bootstrap as a `SECURITY DEFINER` RPC** (`bootstrap_workspace()` in
   `0004_rls.sql`): member-scoped RLS can't self-insert the *first*
   membership row (chicken-and-egg), and the client can't safely create
   plan rows. The RPC idempotently creates Founder plan → workspace →
   owner member → workspace_config, and returns the existing workspace on
   re-login. Also added `user_workspace_ids()` (SECURITY DEFINER helper)
   to avoid the classic workspace_members RLS self-recursion bug.
6. **Founder plan row is created by the RPC, not seeded in 0001** — keeps
   0001–0003 byte-faithful to PRD §5 DDL.
7. **RLS is select/insert only, exactly per PRD 5.4 prose.** Sprint 5
   (Settings edits, lead status updates) will need `update` policies —
   those land as a NEW migration then (0004 stays append-only).
8. **Scoring interpretation calls** (PRD §4 gives weights but not every
   edge): technical/conversion/freshness subscores = equal-weighted
   pass/fail checks within each signal; unknown/null platform scores as
   custom (85); unmeasured PSI on a live site = neutral 50 (not 0 — avoids
   fake "your site is slow" pitches); "Builder site" tag = platform score
   ≤ 45 (Wix, GoDaddy, Squarespace); dead-site "sellability boost" is the
   natural inverted-health effect (100−10=90 at 40% weight — no extra
   fudge constant); half-stars deferred (PRD marks them optional). All
   constants in `packages/shared/src/scoring.ts` for your hand-tuning.
9. **Worker runtime:** `tsx watch` for dev + `dotenv` for env loading —
   both boring, neither on the banned list. JWT middleware is a
   presence-only stub (documented TODO for real verification in Sprint 2).
10. **`npm audit`: 5 findings, all inside the vitest→vite→esbuild dev-only
    chain** (known esbuild dev-server advisory). No runtime dependency
    affected; resolves whenever vitest/vite get bumped. Left alone rather
    than force-upgrading mid-sprint.

## 4. BLOCKED / what Joey must do (exact steps)

Nothing blocked the sprint itself. These are the manual steps only you can
do — the app is fully wired to come alive once they're done:

**A. Supabase project (~10 min)**
1. https://supabase.com → New project (name: `rapidforge`; save the DB password in your password manager).
2. SQL Editor → run each file **in this order**, one at a time:
   `supabase/migrations/0001_tenancy.sql` → `0002_domain.sql` → `0003_operational.sql` → `0004_rls.sql`.
3. Authentication → Providers: Email is on by default (magic link). For
   Google: Google Cloud Console → OAuth consent screen (External) → create
   OAuth Client ID (Web application) → paste client ID + secret into
   Supabase's Google provider form → add the callback URL Supabase displays
   to the OAuth client's authorized redirect URIs.
4. Authentication → URL Configuration → Site URL: `http://localhost:5173`.

**B. Env files (never committed; `.gitignore` already covers them)**
- `apps/web/.env` ← copy `.env.example`: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY` (Project Settings → API).
- `apps/worker/.env` ← copy `.env.example`: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` (same page — service_role, worker only),
  `GOOGLE_PLACES_API_KEY` (GCP → enable **Places API (New)** → server key,
  IP-restricted), `PAGESPEED_API_KEY` (GCP → enable PageSpeed Insights
  API), `ANTHROPIC_API_KEY` (console.anthropic.com). `YELP_API_KEY` can
  wait until Sprint 6.

**C. Verify end-to-end (~2 min)** — `npm run dev`, sign in via magic link,
confirm you land in the shell; in Supabase Table Editor check `plans` has a
`founder` row and `workspaces` / `workspace_members` / `workspace_config`
each gained one row.

**D. Sprint 0 reminder (separate repo).** PRD §11 Sprint 0 — verify
`claude-fable-5` + refusal→`claude-opus-4-8` fallback in
`rapidforge-ai-core` — hasn't been run. Not needed for Sprint 2
(deterministic Places work) but required before Sprint 3's LLM summaries.

**E. GitHub (optional, when ready).** No remote is configured. When you
want it on GitHub: create `jcolley2019/rapidforge` (private), then
`git remote add origin ...` and push yourself — I won't.

## 5. Recommended Sprint 2 kickoff prompt

```
Prompt S2 — RapidForge Sprint 2 (Scout + search flow) — AUTONOMOUS SESSION MODE

Autonomous Session Mode is GRANTED for Sprint 2 per CLAUDE.md Section 12. Repo: C:\dev\rapidforge. Read CLAUDE.md, then PRD Sections 3.3, 3.5, 6.1, 6.2, 8, and 11 (Sprint 2) before writing anything.

STATUS FROM SPRINT 1: monorepo, web shell + auth, worker skeleton, shared scoring, migrations 0001–0004 all in place. I have [applied the migrations / filled both .env files — SAY IF NOT, and Claude must treat live-API acceptance as BLOCKED and still build everything code-side].

DELIVERABLES (PRD Section 11, Sprint 2):
1. Scout agent: Places (New) Nearby Search with grid tiling for radius >~5mi, Place Details enrichment, dedupe by place_id, is_chain heuristic, website_kind classification ('real'|'social_only'|'none'), upsert into businesses on (workspace_id, google_place_id), one usage_events row per Places call.
2. Worker HTTP: POST /api/searches (zip_radius mode) per PRD Section 8 — creates searches row + enqueues scout job; GET /api/searches/:id returns search + paginated results (polling). Real Supabase JWT verification replaces the Sprint 1 stub.
3. Queue: 2s poller claims jobs atomically (FOR UPDATE SKIP LOCKED), dispatches via orchestrator, marks done/failed with attempts + error.
4. Web: New Search view (zip, radius slider 1–25 + presets, searchable category picker, min reviews / min rating), Live Search view polling GET /api/searches/:id, results table sorted by review count.
5. No audit agents yet, no Realtime yet — Sprint 3/4.

ACCEPTANCE: "plumber, 83704, 10mi" returns 20–50 businesses with name/phone/rating/reviews within 60s; usage_events rows exist for every Places call; tsc clean everywhere; no keys reach the browser.

HARD LIMITS: same as CLAUDE.md 12 — no push, no SQL execution (new tables/policies = new migration files only), no resource creation, PowerShell syntax, SESSION_REPORT.md before stopping.
```

## 6. Loose ends worth knowing

- Git warns `LF will be replaced by CRLF` on Windows — cosmetic (autocrlf).
  If it annoys you, a `.gitattributes` with `* text=auto eol=lf` is a
  one-commit fix; didn't add one un-asked.
- `apps/web/src/features/auth/useAuth.ts` re-checks membership on every
  auth event (including token refresh). Cheap (one indexed select), but
  worth revisiting when TanStack Query lands in Sprint 2+.
- Model constants live in `apps/worker/src/lib/ai.ts` and CLAUDE.md 4.1
  names appear nowhere else; grep for `claude-` before Sprint 3 to keep it
  that way.
