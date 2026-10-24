# RFL.EVAL.5 — blind eval: Analyst + Builder Brief, Opus 4.8 vs Sonnet 5.5

Goal: decide whether Analyst and Builder Brief can move from claude-opus-4-8 to claude-sonnet-5-5 without a quality drop. Real spend on Joey's ANTHROPIC_API_KEY from apps/worker/.env. Hard cap $8.00 total; the script stops cleanly at the cap and still writes the report from whatever completed. Never read or print .env. Nothing is written to Supabase.

## 1. Model override (one commit)
- apps/worker/src/agents/analyst.ts: add `model?: ModelId` to AnalystContext; runAnalyst uses `ctx.model ?? MODEL_OPUS`. Export nothing new besides the field.
- apps/worker/src/agents/builder-brief.ts: same on BuilderBriefContext / runBuilderBrief.
- Add one unit test per agent proving the override reaches the AI call (use the existing fake-provider seam setAiProviderForTests). Existing test counts must not drop (shared 89 / worker 577 / web 109); new ones may raise worker.
- Commit: feat(agents): optional model override for Analyst and Builder Brief (RFL.EVAL.5).

## 2. Eval script (one commit): apps/worker/scripts/eval-analyst-brief.ts
Run from apps/worker: `npx tsx scripts/eval-analyst-brief.ts`. Must run WITHOUT RAPIDFORGE_FORCE_FIXTURES. Reads Supabase with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same pattern as scripts/rescore-spot-check.ts). Use SupabaseStore from src/store where it has the method you need (getWorkspaceConfig, getLatestCompletedAuditForBusiness, listAuditsForBusiness); raw client for the rest.

Lead selection: deterministic. All completed audits whose business is analyst-eligible per the current rules in src/agents/analyst.ts (star ≤ ANALYST_MAX_STAR_GRADE, sellability ≥ ANALYST_SELLABILITY_THRESHOLD, not chain, not provisional), one audit per business (the display audit), sorted by business id, take the first 20. Print the list (name, star, sellability) before any paid call. If fewer than 12 qualify, stop and report — do not loosen the rules.

Per lead, with config = the workspace's getWorkspaceConfig (resolve the workspace id from the workspaces/workspace_config table — single workspace; print the id you used):
- Analyst ×2: runAnalyst({ business, audit, config, model }) for MODEL_OPUS and MODEL_SONNET.
- Builder Brief ×2: runBuilderBrief({ business, audit, config, competitors, siteHtmlExcerpt, model }) for both models. competitors = fetchCompetitors(...) exactly as the on-demand route in src/http.ts does; siteHtmlExcerpt via the same fetchHomepage + htmlToExcerpt path, null on failure. force: true so the brief regenerates rather than reusing stored output.
- Track cost from each result's costMicrocents (sumMicrocents). Before every paid call, check projected spend; stop at 800 cents.
- Save every raw output to apps/worker/.eval/<timestamp>/<businessId>.<agent>.<model>.json (or .md for briefs). Add `.eval/` to apps/worker/.gitignore in this commit.

Judge: claude-sonnet-5-5 via the same lib/ai.ts path (generateJsonSummary with a strict schema), effort "low", one call per pair. The judge sees the AuditFacts (buildAuditFacts(business, audit)) and two candidates labeled A and B; which model is A is randomized per pair with a seeded RNG and the mapping is saved. The judge never sees model names. Rubric, each 1–5:
- Analyst: factual_grounding (no claim unsupported by the facts), specificity (names this business's actual problems), actionability, verdict_fit (verdict matches the star grade band).
- Builder Brief: factual_grounding, specificity, completeness (every section the system prompt requires is present and non-generic), buildability (a developer could start from it without asking questions).
Plus `preferred: "A"|"B"|"tie"` and a one-sentence `reason`. Judge calls count toward the cap.

Report: docs/EVAL-2026-10-24.md with: leads used (count, how selected), spend by agent and model, per-criterion mean scores per model, win/loss/tie counts, the three largest score gaps with the judge's reason, and a RECOMMENDATION section stating for each agent: keep Opus / move to Sonnet / inconclusive, with the rule you applied (move only if Sonnet wins or ties ≥ 70% of pairs AND its factual_grounding mean is within 0.3 of Opus). Do NOT change the production model constants in this brick — the recommendation is for the architect.
Commit: feat(eval): blind Analyst + Builder Brief eval script and 2026-10-24 report (RFL.EVAL.5).

## 3. Gate
Typecheck clean; `npm run test -w apps/worker` and the web/shared suites not below 577/109/89; the script ran to completion or to the cap and the report exists; git clean and pushed.

## 4. Report
Print between "=== REPORT — RFL.EVAL.5 ===" and "=== END REPORT ===": commits, leads used, total spend and per-agent split, the win/loss/tie table and mean scores per model, your recommendation per agent, test counts, up to three worth-knowing notes. Do not paste the eval doc itself.
