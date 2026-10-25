# RFL.DATA.1 — delete a search; clear all workspace data

Why: the app can only add. There is no way to remove a search or start fresh short of SQL. Two features, workspace-scoped, usage_events untouched (cost ledger, as migration 0009 did).

## 1. Store (one commit)
Add to the store interface (src/store/index.ts) and implement in SupabaseStore and the in-memory store:
- `deleteSearch(workspaceId, searchId): Promise<{ results, businesses, audits, jobs, agentRuns }>` — refuse (throw a typed error) if search.status is running/queued. Delete: search_results of the search; businesses of this workspace that appear in NO remaining search_results row (orphans) → their audits (cascade), agent_runs with target_id in those businesses, jobs whose payload->>'business_id' is one of them; agent_runs/jobs whose input/payload search_id is this search; then the search. Follow migration 0009's child-first order and FK notes; wrap in one Postgres transaction (an rpc/plpgsql function in a new migration is acceptable if the supabase-js client can't do a multi-statement transaction — if you add a migration, it is supabase/migrations/0011_delete_helpers.sql, Joey runs it, and you print the whole file in the report).
- `clearWorkspaceData(workspaceId): Promise<same counts>` — same tables, everything in the workspace, same order. Keep workspaces, workspace_members, workspace_config, usage_events.
Tests: in-memory store unit tests for both (orphan logic: a business in two searches survives deleting one; running search refused). Commit: feat(store): deleteSearch and clearWorkspaceData (RFL.DATA.1).

## 2. Routes (one commit) — src/http.ts, same auth/workspace pattern as POST /api/searches/:id/cancel
- `DELETE /api/searches/:id` → 404 if not in workspace; 409 { error: "Cancel the search before deleting it" } if running/queued; 200 with counts.
- `DELETE /api/workspace/data` with JSON body { confirm: "DELETE ALL" } → 400 unless the phrase matches exactly; 200 with counts.
Route tests with the in-memory store (both success paths, 404, 409, 400). Commit: feat(http): delete search and clear workspace data routes (RFL.DATA.1).

## 3. Web (one commit)
- src/lib/api.ts: deleteSearch(id), clearWorkspaceData(confirmPhrase).
- DashboardView recent-searches list: a trash icon per row (lucide Trash2, ghost button, aria-label "Delete search"); click opens the existing confirm/dialog component from components/ui (use what's there; if none exists use window.confirm) with the search's query, location and business count; on confirm call deleteSearch, refetch, toast the counts; disabled with tooltip "Cancel first" while running.
- SettingsView: a "Danger zone" card at the bottom, red outline: text explaining what is removed and that Settings and the cost ledger stay; an input "Type DELETE ALL to confirm"; the button enables only on exact match; on success toast counts and navigate to Dashboard; the dashboard/leads queries must refetch (invalidate whatever cache layer is used — check how views refresh after reauditBusiness).
- Tests: web suite — one for the danger-zone enable logic, one for the dashboard delete button's running-state disable. Commit: feat(web): delete search and clear-all danger zone (RFL.DATA.1).

## 4. Docs (one commit)
docs/HOW-IT-WORKS.md: short "Deleting data" paragraph (orphan rule, what is kept). Help page content (HelpView) gets one line under the relevant section. Commit: docs: deleting searches and clearing data (RFL.DATA.1).

## 5. Gate
Typecheck clean; shared 89; worker ≥ 599 + new; web ≥ 109 + new; `git status` clean, pushed. After Railway and Vercel deploy: with Claude in Chrome at https://app.rapidforgeai.com (Joey approves sign-in), delete one completed search from the Dashboard and confirm it disappears and the Leads count drops only by its orphan businesses; do NOT run clear-all on the live workspace.

## 6. Report
Print between "=== REPORT — RFL.DATA.1 ===" and "=== END REPORT ===": commits, whether a migration was added (and its full text if so), test counts, the live delete check (before/after counts), up to three worth-knowing notes.
