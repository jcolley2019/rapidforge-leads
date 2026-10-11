# RFL.HOST.6 — the RapidForge worker image (Railway). Built from the repo
# root: npm workspaces need the root manifest + lockfile and every workspace
# package.json. The web app is NOT in this image (it ships to Vercel).
FROM node:22-slim

# Chromium + fonts for screenshots and the PDF report (SCREENSHOTS_ENABLED=
# true); git + ca-certificates so npm can fetch the git dependency
# @rapidforge/ai-core.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Worker + shared runtime dependencies only. tsx is a worker dependency
# (the worker runs its TypeScript through it), so no devDependencies needed.
RUN npm ci --omit=dev -w apps/worker && npm cache clean --force

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Production refuses dev-mode auth: without SUPABASE_URL + the service-role
# key the worker will not start. Keyless smoke test of the image:
#   docker run --rm -e NODE_ENV=development -e PORT=8788 -p 8788:8788 rfl-worker
ENV NODE_ENV=production
EXPOSE 8788
CMD ["npm","run","start","-w","apps/worker"]
