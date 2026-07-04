# RapidForge

Multi-agent local lead generation platform. Finds local businesses (Google
Places), audits their websites (deterministic measurements + AI
interpretation), scores Health (0–100 → 1–5★) and Sellability (0–100), and
produces per-lead deliverables: issues list, Analyst verdict, Builder
Brief, Sales Summary talk track.

Source of truth: **`RapidForge-PRD.md`** (v2.1). Working rules:
**`CLAUDE.md`**.

## Monorepo layout

```
apps/web          Vite + React 18 dashboard (→ Vercel). Anon key + RLS only. Zero secrets.
apps/worker       Node/Express pipeline (local in v1). Holds ALL secrets. Jobs poller + agents.
packages/shared   Zod schemas, scoring constants + pure functions, AgentEvent types.
supabase/         Migration SQL files — applied ONLY by hand in the Supabase web SQL editor.
```

## Prerequisites

- Node.js 20+ (built on 24.x) and npm 10+
- A Supabase project (free tier is fine) — see setup below

## Setup

```powershell
git clone <repo> C:\dev\rapidforge
Set-Location C:\dev\rapidforge
npm install
npm run dev     # web on http://localhost:5173, worker on http://localhost:8788
```

`npm run dev` works with **no env files present**: the web app runs in
offline preview mode (banner shown, auth disabled) and the worker starts
with the jobs poller disabled. Nothing crashes on a fresh clone.

### 1. Create the Supabase project

1. https://supabase.com → New project (any region close to you).
2. SQL Editor → paste and run each migration **in order**:
   `supabase/migrations/0001_tenancy.sql` → `0002_domain.sql` →
   `0003_operational.sql` → `0004_rls.sql`.
3. Authentication → Providers → enable **Email** (magic link is on by
   default) and **Google** (needs an OAuth client from Google Cloud
   Console; paste its client ID + secret into the Supabase Google
   provider form and add the callback URL Supabase shows you).
4. Authentication → URL Configuration → set Site URL to
   `http://localhost:5173` for local dev.

### 2. Web env — `apps/web/.env`

Copy `apps/web/.env.example` → `apps/web/.env`.

| Variable | Where it comes from |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` key |

**Never** put anything secret behind a `VITE_` prefix — Vite inlines those
values into the shipped browser bundle.

### 3. Worker env — `apps/worker/.env`

Copy `apps/worker/.env.example` → `apps/worker/.env`.

| Variable | Where it comes from |
|---|---|
| `SUPABASE_URL` | Same project URL as above |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key (bypasses RLS — worker only, never the browser) |
| `GOOGLE_PLACES_API_KEY` | Google Cloud Console → enable **Places API (New)** → Credentials → server API key (IP-restrict it) |
| `PAGESPEED_API_KEY` | Google Cloud Console → enable **PageSpeed Insights API** → API key |
| `YELP_API_KEY` | https://www.yelp.com/developers → Fusion API key (v1.5 — leave blank until Sprint 6) |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API keys (used only via RapidForge AI Core) |
| `WORKER_PORT` | Local HTTP port, default `8788` |

### 4. First sign-in

Sign in with a magic link or Google. On first sign-in the app calls the
`bootstrap_workspace` RPC (created in `0004_rls.sql`), which creates the
Founder plan row, your workspace, your owner membership, and default
workspace config.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | web + worker together via concurrently |
| `npm run typecheck` | `tsc --noEmit` in shared, worker, web |
| `npm run test` | vitest on `packages/shared` (scoring) |

## Ground rules (short form — CLAUDE.md is the law)

- Scores are deterministic math in `packages/shared/src/scoring.ts`; LLMs
  never assign scores.
- All AI calls go through RapidForge AI Core — no direct Anthropic SDK.
- SQL is never executed by tooling; migrations are pasted by hand.
- The job queue is the Postgres `jobs` table + 2s poller. No Redis.
- No-website businesses are sellability-95 hot leads, never skips.
