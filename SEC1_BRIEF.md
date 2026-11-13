# RFL.SEC.1 — close the three P0s from docs/AUDIT-2026-11-13.md, plus the dependency fixes

Read the P0 section and P1-7 of docs/AUDIT-2026-11-13.md first; it holds the file:line evidence. Supabase sign-up was turned off in the dashboard today, and the architect already set ALLOWED_EMAILS on the Railway worker (deploy skipped, so it takes effect with your push). Never read or print .env. One commit per item, explicit paths, push at the end.

## 1. RFL.HTTP.1 — a bad request must never kill the worker
- apps/worker/src/http.ts:574: the `decodeURIComponent(req.params.ref)` runs outside the handler's try. Move it inside and answer 400 on a malformed value.
- Check every other async route in http.ts for code that can throw outside its try, and make a rejected handler answer 500 instead of leaving an unhandled rejection (one small wrapper applied to the routes is fine).
- apps/worker/src/index.ts: log `unhandledRejection` and `uncaughtException` with a clear prefix. A rejection must not exit the process.
- Tests: `GET /api/places/photo/%25` → 400 and the server still answers the next request.
Commit: fix(http): malformed photo ref answers 400; rejected handlers cannot crash the worker (RFL.SEC.1)

## 2. RFL.AUTH.1 — allowlist
- apps/worker/src/middleware/auth.ts, after `getUser`: when env ALLOWED_EMAILS is set (comma-separated, trimmed, case-insensitive), a user whose email is not on it gets 403 "This account is not allowed". Unset = today's behavior, so local dev and the tests are unchanged.
- /health gains `auth_allowlist: "on" | "off"` (never the emails).
- Add ALLOWED_EMAILS to apps/worker/.env.example and the worker env table in docs/DEPLOY.md; note there that Supabase sign-up is off and how to add a user (Supabase → Authentication → Users → Add user, then add the email to ALLOWED_EMAILS).
- Tests: listed email passes, unlisted 403, unset passes, case and spaces ignored.
Commit: feat(auth): ALLOWED_EMAILS allowlist on the worker (RFL.SEC.1)

## 3. RFL.RLS.1 — members cannot write pipeline tables; jobs are workspace-checked
- You are granted supabase/migrations for this item. New file supabase/migrations/0012_member_write_lockdown.sql: drop the member INSERT policies from 0004_rls.sql on businesses, audits, jobs, agent_runs, usage_events, search_results and searches. First confirm what the web really writes through supabase-js: the architect's grep found only SELECTs on agent_runs and workspace_members and the bootstrap_workspace rpc. If you find a member UPDATE or DELETE policy on these tables that the web does not use, drop it too; keep every SELECT policy (Realtime depends on them). The file records itself in schema_migrations, and also inserts the missing '0010_business_demo' row (on conflict do nothing). Joey runs the SQL; you do not.
- apps/worker/src/orchestrator.ts (handleAuditBusinessJob, handleScoutJob): fail the job, with a clear error, when the job's workspace_id differs from its search's or business's. Tests for both.
Commit: fix(rls,queue): members cannot insert pipeline rows; jobs must match their workspace (RFL.SEC.1)

## 4. RFL.SSRF.1 — the worker only fetches public addresses
- One `assertPublicUrl` in apps/worker/src/lib: http/https only; resolve the host and reject loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, including the metadata address), CGNAT (100.64/10), 0.0.0.0, and the IPv6 equivalents (::1, fc00::/7, fe80::/10, v4-mapped).
- Use it in lib/site.ts, lib/probe.ts, lib/screenshots.ts and lib/browser.ts before the first request and on every redirect hop (manual redirect handling where fetch is used; in Puppeteer, check main-frame navigation requests). A blocked URL is treated like an unreachable site: the audit continues and records the reason; it must not throw out of the pipeline.
- The resolver must be injectable so the tests stay hermetic. Tests: each blocked range, a public address passes, a redirect from public to private is blocked.
Commit: feat(worker): assertPublicUrl blocks private and loopback targets (RFL.SEC.1)

## 5. RFL.DEPS.1 — vulnerable runtime packages
`npm audit fix` (no --force), and bump the worker's zod to the patched 4.6.x. Re-run the three suites. If a suite breaks because of an upgrade, revert that package only and say which.
Commit: chore(deps): npm audit fix + zod patch (RFL.SEC.1)

## Gate
Typecheck clean in all three workspaces. Tests not below shared 93 / worker 616 / web 127, plus the new ones, hermetic. `npm audit --omit=dev` high/critical count before and after. Git clean and pushed. After Railway redeploys: /health is 200 and shows auth_allowlist "on"; a garbage Bearer token still gets 401 on GET /api/leads.

## Report
Print between the lines "=== REPORT — RFL.SEC.1 ===" and "=== END REPORT ===": commits; test counts; npm audit before and after; the /health line; the FULL text of 0012_member_write_lockdown.sql (Joey pastes it into Supabase); up to three worth-knowing notes. No other code or diffs.
