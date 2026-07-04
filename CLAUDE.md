# CLAUDE.md — RapidForge

> **Loaded automatically by Claude Code at the start of every session. Read it. Follow it.**
> v1.2 — 2026-07-04 (aligned with PRD v2.1: monorepo, deterministic scoring, jobs queue, Realtime, Autonomous Session Mode)

---

## 1. Project Identity

**RapidForge:** multi-agent local lead generation platform. Find local businesses (Google Places), audit their websites (deterministic measurements + AI interpretation), score Health (0–100) → star grade (1–5) and Sellability (0–100), and produce per-lead deliverables: issues list, Analyst verdict, Builder Brief, Sales Summary talk track.

- **Owner:** Joey Colley (solo dev; single user in v1; multi-tenant schema from day one)
- **Repo:** `jcolley2019/rapidforge` (private) · **Local:** `C:\dev\rapidforge` (NOT under OneDrive)
- **Source of truth:** `RapidForge-PRD.md` (v2.1) in repo root. Consult before building any agent, table, or view.

**Topology:** npm workspaces monorepo — `apps/web` (Vite dashboard → Vercel, anon key + RLS only, zero secrets) · `apps/worker` (Node/Express pipeline — local in v1, Railway later — holds ALL secrets, runs the jobs poller, broadcasts Realtime events) · `packages/shared` (Zod schemas, scoring constants, event types) · `supabase/` (migrations, applied only by Joey in the web SQL editor).

---

## 2. Working Rules (Non-Negotiable)

1. **Read before write.** View any file before editing it. No blind edits.
2. **Plan mode for non-trivial changes** in supervised sessions; present the plan and wait. (Autonomous sessions: see Section 12.)
3. **One problem per commit.** No bundled changes; no refactoring while bug-fixing.
4. **Surgical fixes only.** Minimal diffs; never rewrite a file when an edit will do.
5. **`npx tsc --noEmit` must pass** in every workspace you touched before committing.
6. **Never `git push` without Joey's explicit go.** Local commits are fine.
7. **Revert fast** instead of patching forward.
8. **Show diffs before staging** in supervised sessions. Stage by explicit path — never `git add -A`.
9. **Prompt deliveries to Joey:** one complete block, label as the FIRST LINE inside the fence (e.g., `Prompt S3.2 — Conversion agent`).
10. **Sprint vocabulary:** S0–S8 map to PRD Section 11. Gate on acceptance tests.
11. **SQL never executes from here.** Write migration files in `supabase/migrations/`; Joey pastes them into the Supabase web editor. Never run SQL via MCP/CLI against any Supabase project.

---

## 3. Protected Files (Ask Before Touching)

- `supabase/migrations/**` once written — append-only, never edit applied migrations
- Generated Supabase types (`packages/shared/src/db.types.ts` or equivalent)
- `.env`, `.env.*` anywhere — never read aloud, never commit, never echo values
- `CLAUDE.md`, `RapidForge-PRD.md`
- `packages/shared/src/scoring.ts` weights — Joey tunes these by hand after real audits

---

## 4. Tech Stack (Fixed — Do Not Swap or Suggest Alternatives)

- **Web:** Vite + React 18 + TypeScript strict + Tailwind + shadcn/ui + Framer Motion + cmdk + TanStack Query + TanStack Table (virtualized)
- **Worker:** Node + Express + TypeScript; Puppeteer for screenshots/PDF; job queue = the Postgres `jobs` table with a 2s poller (NO BullMQ/Redis)
- **DB:** Supabase (Postgres + RLS, Storage, Auth magic-link + Google OAuth, Realtime broadcast)
- **AI:** **ONLY through RapidForge AI Core** (`github.com/jcolley2019/rapidforge-ai-core`; local `C:\Users\jcoll\OneDrive\Desktop\rapidforge-ai-core`). App code never imports the Anthropic SDK and never fetches `api.anthropic.com` directly.
- **Perf data:** Google PageSpeed Insights API (free) — NOT self-hosted Lighthouse
- **Places:** Google Places API (New) — worker only
- **Deploy:** Vercel (web). Worker runs locally in v1; Railway when v1 proves out.

**Do not introduce:** Next.js (in this repo), Prisma, Drizzle, Material UI, Chakra, Redux/Zustand/Jotai, LangChain/LlamaIndex, BullMQ/Redis, pnpm (npm workspaces only).

### 4.1 Model Assignments (current lineup — retired names appear nowhere)

| Model | ID | Used for |
|---|---|---|
| Claude Haiku 4.5 | `claude-haiku-4-5` | Filter edge-pass; cheap classification |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Audit summaries, Design (vision), Reputation, SEO, Sales Summary, Keyword Parser |
| Claude Fable 5 | `claude-fable-5` | Analyst + Builder Brief ONLY |
| Claude Opus 4.8 | `claude-opus-4-8` | Automatic fallback when Fable 5 returns a refusal |

**Fable 5 rules:** adaptive thinking always on (`effort` controls cost) · temperature 1.0 or unset · `stop_reason: "refusal"` arrives as HTTP 200 — retry the identical request on `claude-opus-4-8`, never crash, never stall a job. "Opus 4.7" and "GPT-5.5" are not real model IDs — if you see them in any doc, flag it.

### 4.2 Scoring Doctrine
Scores are **deterministic math** (PRD Section 4; constants in `packages/shared/scoring.ts`). LLMs never assign Health, star, or Sellability scores — they interpret, critique, and write narrative on top of measured data. **Deterministic before AI:** if the worker can measure it, the worker measures it and the model receives it as fact.

---

## 5. Windows + PowerShell

All terminal commands in PowerShell syntax. Paths use backslashes (`C:\dev\rapidforge\apps\worker\src\agents\health.ts`).

| Unix (wrong) | PowerShell (correct) |
|---|---|
| `rm -rf x` | `Remove-Item -Recurse -Force x` |
| `ls -la` | `Get-ChildItem -Force` |
| `cp -r a b` | `Copy-Item -Recurse a b` |
| `mkdir -p a/b` | `New-Item -ItemType Directory -Force -Path a/b` |
| `cat f` | `Get-Content f` |
| `touch f` | `New-Item f` |
| `mv a b` | `Move-Item a b` |
| `export V=x` | `$env:V = "x"` |
| `which node` | `Get-Command node` |

`npm`, `npx`, `node`, `git`, `tsc` are cross-platform — use as-is.

---

## 6. Agent Conventions

Full specs: PRD Section 6. Universal rules:

1. **Strict JSON** from every LLM agent (Builder Brief outputs markdown). Zod-validate before persisting.
2. **Self-check guardrails** per agent as pure functions in `apps/worker/src/agents/guardrails/`. Fail → re-run once → on second failure persist with `guardrail_passed:false` + notes, flag for review. Never silently accept bad output.
3. **Citations:** every claim carries a URL, metric name+value, or literal `"inference"`. Missing data = `"unknown"`, never invented.
4. **Cascading variables** (`{your_offer}`, `{target_industry}`, `{ideal_website_traits}`, `{sales_tone}`, `{user_location}`, `{user_brand}`) come from `workspace_config` through ONE shared template function — never hardcoded in prompts.
5. **Every agent run** writes an `agent_runs` row (status, model_used, tokens_used, cost_cents, duration, guardrail fields) and emits Realtime AgentEvents (started/progress/completed/failed).
6. **File layout:** one agent per file in `apps/worker/src/agents/`; prompts in `agents/prompts/`; guardrails in `agents/guardrails/`; orchestration in `apps/worker/src/orchestrator.ts`; queue in `apps/worker/src/queue.ts`; events in `apps/worker/src/events.ts`.
7. **Special routing is law:** no-website → sellability-95 hot lead (never skipped, never audited); social-only → same; dead site → health 10 "Site broken — urgent."

---

## 7. Commit Conventions

`<type>(<scope>): <subject>` — types: feat/fix/refactor/chore/docs/style/test · scopes: `agent-<name>`, `db`, `web`, `worker`, `shared`, `orchestrator`, `queue`, `export`, `config`.

Pre-commit: tsc clean in touched workspaces → no stray `console.log` → no secrets → stage by explicit path → (supervised) Joey saw the diff.

---

## 8. Cost Discipline

Haiku for classification, Sonnet by default, Fable ONLY for Analyst + Builder Brief (and Analyst auto-runs only at sellability ≥ 60; Brief + Sales Summary are on-demand). 30-day audit cache. Filter before any spend. 5-business concurrency cap. Log tokens + cost on every call. Places calls logged to `usage_events`. **Monthly target <$200** — flag anything that risks it.

---

## 9. Security & Secrets

All secrets in `apps/worker/.env` only (Anthropic, Places server key, PSI key, Yelp, Supabase service-role). Web gets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and (v1.5) the referrer-restricted `VITE_GOOGLE_MAPS_BROWSER_KEY` — **nothing secret ever gets a `VITE_` prefix** (Vite inlines those into the shipped bundle). Verify `.gitignore` covers `.env*` before first commit. Worker validates Supabase JWTs on its HTTP API.

---

## 10. Out of Scope (v1) — Stop and Confirm If Drifting

Stripe/billing/quotas, team invites, integrations, outreach sending, Reply Classifier, marketing site, BYOK, native mobile, multi-language, reselling Places data.

---

## 11. Quick Reference

| Situation | Action |
|---|---|
| About to edit a file | View it first |
| Non-trivial change (supervised) | Plan → wait for approval |
| About to push | Stop. Ask Joey. |
| About to run SQL | Don't. Write a migration file for Joey to paste. |
| About to call Anthropic directly | Don't. RapidForge AI Core. |
| Fable returned stop_reason "refusal" | Retry identical request on claude-opus-4-8 |
| Tempted to add a library/refactor | Don't. Note it and ask. |
| LLM about to assign a score | Wrong — scores are deterministic (shared/scoring.ts) |
| Business has no website | Hot lead (sellability 95), NOT a skip |
| Agent output fails guardrails | Re-run once → then persist flagged, move on |
| Unsure who owns behavior / a field | PRD Sections 6 / 5 |
| Writing a terminal command | PowerShell (Section 5) |
| Test fails | Stop, revert, rethink |

---

## 12. Autonomous Session Mode

Off by default. Active ONLY when Joey's kickoff prompt explicitly says "Autonomous Session Mode" and names the sprint. While active:

**Granted:** plan internally without waiting; execute the named sprint end-to-end; create/edit files within the sprint's scope; run installs, tsc, dev-server smoke checks; make local commits after each logical step with conventional messages.

**Still forbidden — no exceptions:** `git push` · executing SQL anywhere · creating/modifying Supabase, Vercel, Railway, or Google Cloud resources · touching `.env` real files or echoing secrets · installing libraries on the Section 4 banned list · work outside the named sprint's deliverables · deleting files not created this session.

**If blocked** (missing credential, ambiguous requirement, failing acceptance): do NOT improvise around it. Record it in the report, mark the item BLOCKED, continue with independent items.

**Exit requirement:** write `SESSION_REPORT.md` at repo root containing: sprint + scope; everything built (by commit); acceptance test results (pass/fail per item, with command output); decisions made and why; anything BLOCKED and what Joey must do (exact steps: keys to create, SQL to paste, env values to fill); recommended next prompt. This report is the handoff — write it like Joey will read it cold.

---

**End of CLAUDE.md. When in doubt, re-read before acting.**
