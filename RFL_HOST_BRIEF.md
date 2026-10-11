# RFL.HOST.6 — Make the app hostable: worker on Railway (Docker), web on Vercel

Work directly on main in C:\dev\rapidforge-leads. One problem per commit, explicit-path
staging. No schema changes. Do not read or print .env. Test counts must not drop
(shared 89 / worker 569 / web 109; web runs via `npm run test -w apps/web`).
Nothing in this brick deploys anything — it makes the repo deployable and verifies
locally. Joey creates the Railway service and the architect creates the Vercel project
afterwards.

## 1. Port + CORS (commit 1)

- apps/worker/src/index.ts: port = Number(process.env.PORT ?? process.env.WORKER_PORT ?? 8788).
  Railway injects PORT; local .env keeps WORKER_PORT.
- Add the `cors` package to apps/worker. In apps/worker/src/http.ts, before express.json():
  allow origins from env WEB_ORIGINS (comma-separated, trimmed), plus http://localhost:5173
  always; allowed methods GET,POST,PUT,DELETE,OPTIONS; allowed headers Authorization,
  Content-Type; no credentials. Unset WEB_ORIGINS → localhost only. Put the parsing in
  apps/worker/src/lib/env.ts next to the other env readers so it is unit-testable.
- Tests in apps/worker/src/http.test.ts: a request with Origin http://localhost:5173 gets
  Access-Control-Allow-Origin; an Origin not in the list gets none; an OPTIONS preflight
  to /api/searches returns 204 with the allow headers.
- apps/worker/.env.example: document WEB_ORIGINS and PORT (comment: set by the host).

## 2. Dockerfile for the worker (commit 2)

- Repo-root `Dockerfile` (monorepo needs root context for workspaces) and `.dockerignore`
  (node_modules, .git, apps/web/dist, **/.env, docs, *.md except none needed).
- Base node:22-slim. apt-get install chromium plus the fonts it needs
  (fonts-liberation, fonts-noto-color-emoji) and ca-certificates; clean apt lists.
- Copy root package.json + package-lock.json + every workspace package.json first,
  `npm ci --omit=dev` is NOT safe here because the worker starts with tsx (a devDependency)
  — either move tsx to worker dependencies or run `npm ci` in full; pick the smaller
  image that still starts and say which in the REPORT.
- Copy the rest, ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium, ENV NODE_ENV=production,
  EXPOSE 8788, CMD ["npm","run","start","-w","apps/worker"].
- apps/worker/src/lib/browser.ts already honours PUPPETEER_EXECUTABLE_PATH as the sole
  candidate — confirm, do not change it. The headless launch args must include
  --no-sandbox and --disable-dev-shm-usage when running as root in a container; add them
  only under `process.env.PUPPETEER_EXECUTABLE_PATH && process.platform === "linux"` so
  Windows dev is untouched. Unit-test that branch.
- Repo-root `railway.json`: builder DOCKERFILE, dockerfilePath "Dockerfile",
  healthcheckPath "/health", healthcheckTimeout 120, restartPolicyType ON_FAILURE.
- If Docker Desktop is installed and running, `docker build -t rfl-worker .` and
  `docker run --rm -e PORT=8788 -p 8788:8788 rfl-worker` must serve GET /health (the
  worker starts in fixture/offline mode without keys — confirm /health answers). If Docker
  is not available, say so in the REPORT and skip; do not install it.

## 3. Web build for Vercel (commit 3)

- `npm run build -w apps/web` must succeed from a clean checkout (it type-checks then
  vite-builds). If packages/shared is consumed as TypeScript source it will; if the build
  needs shared compiled first, add a root script "build:web" that builds shared then web,
  and document it. Vercel will run with Root Directory = apps/web and install at the
  repo root (npm workspaces are auto-detected).
- apps/web/vercel.json: SPA rewrite `{ "source": "/(.*)", "destination": "/index.html" }`
  so deep links and reloads work.
- Check apps/web/src/features/auth/AuthPage.tsx: state in the REPORT whether sign-in is
  email+password only (no Supabase redirect URL config needed) or uses magic links /
  OAuth (then the Vercel URL must be added to Supabase Auth → URL Configuration — report
  it, do not change Supabase).

## 4. Docs (commit 4)

- docs/DEPLOY.md: what runs where, the full env list for Railway (every key from
  apps/worker/.env.example that applies, plus WEB_ORIGINS, PUPPETEER_EXECUTABLE_PATH is
  baked into the image, DEMOS_DIR deliberately unset → Build demo answers 503 when
  hosted), the three Vercel env vars (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
  VITE_WORKER_URL), and the note that GOOGLE_PLACES_API_KEY must not be IP-restricted
  to Joey's PC once the worker runs on Railway. One paragraph in docs/HOW-IT-WORKS.md
  pointing to it.

## 5. Gate

- `npm run typecheck -w apps/worker`, `npm run typecheck -w apps/web`, `npm test` at root,
  `npm run test -w apps/web`, `npm run build -w apps/web`.
- Start `npm run dev -w apps/worker` and `npm run dev -w apps/web` if not already running
  (check first), confirm the app still works at http://localhost:5173 through the Vite
  proxy (Dashboard loads data) — a plain fetch check is enough, no Chrome session needed.
- `git push` after the last commit.

Print your report between the lines "=== REPORT — RFL.HOST.6 ===" and "=== END REPORT ===":
commits (sha + one line each), spec departures with reasons, the tsx/npm ci decision,
Docker build result or "Docker not available", auth method finding, verification table
(typechecks / shared / worker before→after / web before→after / web build / local app),
git status, up to three "worth knowing" notes. No diffs; print Dockerfile and
railway.json in full (new files).
