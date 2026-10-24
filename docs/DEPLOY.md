# Deploying RapidForge Leads

RFL.HOST.6 made the repo deployable; it did not deploy anything. This page is the checklist for the first hosted run.

**Live (RFL.HOST.7):** the canonical web URL is **https://app.rapidforgeai.com** (Vercel custom domain). `https://rapidforge-leads.vercel.app` stays up as the fallback. The worker is `https://rapidforgeworker-production.up.railway.app`.

## What runs where

| Piece | Host | Built from | Talks to |
|---|---|---|---|
| Web dashboard (`apps/web`) | Vercel | `npm run build -w apps/web` → `apps/web/dist` | Supabase (anon key + RLS) and the worker (`VITE_WORKER_URL`) |
| Worker (`apps/worker`) | Railway | repo-root `Dockerfile` (config in `railway.json`) | Supabase (service role), Google Places, PageSpeed Insights, Yelp, Anthropic via AI Core |
| Database, Auth, Storage, Realtime | Supabase | `supabase/migrations/` (pasted by Joey) | — |

Locally nothing changes: `npm run dev` still runs both, and Vite proxies `/api` and `/fixtures` to `http://localhost:8788`, so local dev never needs CORS.

## Worker on Railway

- **Build:** Dockerfile builder (`railway.json`). The image is `node:22-slim` + Debian Chromium + fonts, with `npm ci --omit=dev -w apps/worker` (tsx is a worker runtime dependency, so devDependencies stay out). It starts with `npm run start -w apps/worker`.
- **Port:** Railway injects `PORT`; the worker listens on `PORT`, falling back to `WORKER_PORT`, then 8788.
- **Health check:** `GET /health` (no login), 120 s timeout. Restart policy: on failure.
- **Production guard:** the image sets `NODE_ENV=production`, so the worker **refuses to start** unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set; dev-mode auth (any Bearer token → the dev workspace) never runs hosted. With Supabase configured it also refuses fixture Places data, so `GOOGLE_PLACES_API_KEY` is required too. A keyless smoke test of the image needs `-e NODE_ENV=development`.

### Railway environment variables

| Variable | Set it? | Notes |
|---|---|---|
| `SUPABASE_URL` | **Required** | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | Bypasses RLS — worker only, never a `VITE_` var |
| `GOOGLE_PLACES_API_KEY` | **Required** | See the IP-restriction note below |
| `PAGESPEED_API_KEY` | Recommended | Without it PSI runs in fixture mode |
| `ANTHROPIC_API_KEY` | Recommended | Without it the summaries, Analyst, Builder Brief and Sales Script are deterministic templates |
| `YELP_API_KEY` | Optional | Reputation agent's Yelp lookup |
| `WEB_ORIGINS` | **Required once the web is on Vercel** | Comma-separated browser origins allowed by CORS. Set to exactly `https://app.rapidforgeai.com,https://rapidforge-leads.vercel.app,http://localhost:5173`. `http://localhost:5173` is always allowed, listed or not |
| `SCREENSHOTS_ENABLED` | Optional (`true`) | Turns on Chromium screenshots (Sonnet vision Design pass, ~2¢/audit) and the real PDF report |
| `PSI_DESKTOP` | Optional (`true`) | Second PageSpeed strategy (one more PSI call per audit) |
| `AI_SUMMARIES` | Optional | `haiku`, or a list such as `reputation,seo`; unset = templates |
| `PORT` | Do not set | Railway injects it |
| `WORKER_PORT` | Do not set | Local-only fallback |
| `PUPPETEER_EXECUTABLE_PATH` | Do not set | Baked into the image as `/usr/bin/chromium` |
| `NODE_ENV` | Do not set | Baked into the image as `production` |
| `DEMOS_DIR` | **Leave unset** | The demo builder spawns a local `rapidforge-demos` checkout; hosted, there is none, so Build demo answers 503 "DEMOS_DIR not configured". Build demos from the local worker |
| `RAPIDFORGE_FORCE_FIXTURES`, `RAPIDFORGE_FORCE_MEMORY_STORE`, `RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE`, `RAPIDFORGE_LEGACY_UA` | Do not set | Local testing/debug switches |

### Google Places key

`apps/worker/.env.example` says to IP-restrict the Places server key to your machine. **Once the worker runs on Railway, that restriction must go**: requests come from Railway's egress IPs, not Joey's PC, so every Places call would fail. Restrict the key by API instead (Places API (New) only), or create a separate key for the hosted worker.

## Web on Vercel

- **Project settings:** Root Directory = `apps/web`, framework Vite. Vercel detects the npm workspace and installs at the repo root, so `@rapidforge/shared` (consumed as TypeScript source) resolves without a separate build step. Build command `npm run build` (type-check + `vite build`), output `dist`.
- **SPA routing:** `apps/web/vercel.json` rewrites every path to `/index.html`, so deep links and reloads work.
- **Environment variables** (all browser-safe; Vite inlines them into the bundle):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon public key (RLS enforced) |
| `VITE_WORKER_URL` | The Railway worker's public URL, e.g. `https://<service>.up.railway.app` (no trailing slash) |

`VITE_GOOGLE_MAPS_BROWSER_KEY` is optional (map-draw search); if set, add `https://app.rapidforgeai.com/*` and `https://rapidforge-leads.vercel.app/*` to its HTTP-referrer restrictions (as of 2026-10-24 the Maps Browser Key allows only `http://localhost:5173/*`).

### Supabase Auth redirect URLs

Sign-in is a **magic link** or **Google OAuth** (`apps/web/src/features/auth/AuthPage.tsx`), and both redirect back to `window.location.origin`. Every origin the app is served from must be in Supabase → Authentication → URL Configuration, or the link and the Google round-trip land on the Site URL or are rejected. Current settings: Site URL `https://app.rapidforgeai.com`; Redirect URLs `https://app.rapidforgeai.com/**`, `https://rapidforge-leads.vercel.app/**`, `http://localhost:5173/**`.

## Order of operations

1. Railway: create the service from this repo, set the worker variables above (leave `WEB_ORIGINS` for step 3), deploy, and check `GET /health`.
2. Vercel: create the project (Root Directory `apps/web`), set the three `VITE_` variables with `VITE_WORKER_URL` = the Railway URL, deploy.
3. Railway: set `WEB_ORIGINS` to the custom domain `https://app.rapidforgeai.com`, the Vercel fallback and localhost (exact value in the table above) and redeploy.
4. Supabase: Site URL = `https://app.rapidforgeai.com`; add it and the Vercel URL to Redirect URLs (Auth → URL Configuration).
5. Google Cloud: lift the Places key's IP restriction (or use a hosted-worker key).

## Hosting hygiene

- **Railway Watch Paths stay empty.** The worker image is built from more than `apps/worker`: `packages/shared`, the root `Dockerfile` and `package-lock.json` all go into it, and a pattern such as `/apps/worker/**` (the setting until 2026-10-24) silently skips the redeploy when only those change. Empty means every push to `main` redeploys the worker.
- **Places key has no application restriction.** Railway has no fixed egress IP, so an IP allow-list would fail every Places call. The key is locked by API instead (Places API (New) + PageSpeed Insights API), Application restrictions = None.
- **Supabase Site URL = `https://app.rapidforgeai.com`.** Magic links and OAuth fall back to it when a redirect isn't on the allow-list.
- **Railway plan (2026-10-24):** Trial, "17 days or $4.33 left" (lapses around 2026-11-10). Move to a paid plan before then or the worker stops.
