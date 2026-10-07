# RFL.AUDIT.2 — per-agent audit, read-only

## Goal
Judge every agent on four questions and write docs/AUDIT-2026-10-07.md. This is not "does it run" — RFL-AUDIT-01 (docs/AUDIT-2026-10.md, Oct 2) covered that. This audit asks, per agent: (a) does it do what it is supposed to do, (b) is it correct, (c) could it be better, (d) what exactly should change. Output is a report plus a ranked fix list written as brick stubs so follow-up bricks come straight from it. Branch rfl-audit-2 off main, PR to main titled "RFL.AUDIT.2 per-agent audit", stage by explicit path, never -A.

NO code changes. The only files in the PR are docs/AUDIT-2026-10-07.md and, if you need it, one read-only probe script apps/worker/scripts/audit2-probe.ts (see §Live check). Do not touch CLAUDE.md, RapidForge-PRD.md, scoring.ts, migrations, or .env.

## Reference material
- docs/HOW-IT-WORKS.md — the code-derived description written yesterday (RFL.DOCS.1). Use it as the map; verify it against the code as you go and list any place it is wrong in §6 of the report.
- docs/AUDIT-2026-10.md — the Oct 2 audit; its 20 findings and the fix bricks RFL-01…RFL.AI.9a, RFL.BRIEF.7, RFL.QUEUE.8/8a, RFL.WEB.10.
- CLAUDE.md §4.1 (models), §4.2 (scoring doctrine), §6 (agent conventions), §8 (cost).
- Code: apps/worker/src/agents/**, agents/prompts/**, agents/guardrails/**, orchestrator.ts, queue.ts, lib/** (ai.ts, probe.ts, site.ts, psi.ts, places/google-client.ts, bot-protection.ts, chains.ts, budget.ts, screenshots.ts), packages/shared/src/scoring.ts and schemas.ts, http.ts.
- Tests: 50 test files / ~514 `it(` blocks. Run `npm test` from the root once at the start and record the counts.

## Part 1 — Did the Oct 2 audit's fixes land?
Table with one row per finding 1–20 of docs/AUDIT-2026-10.md: finding, which brick claimed it, LANDED / PARTIAL / NOT DONE, and the file:line evidence you checked. Do not trust commit messages; read the code. For PARTIAL say what is missing.

## Part 2 — Per-agent audit
One section per agent, in pipeline order: Scout, Filter, Health, Conversion, Presence, Traffic, Design, Reputation, SEO, Scorer, Analyst, Builder Brief, Design Brief, Sales Summary (14 sections). Every section has these four headings, filled in with evidence (file:line, test name, or a stored row), never with impressions:

### (a) Does it do its job?
Compare the agent's actual behaviour against its spec in CLAUDE.md §6 + PRD §6.x + HOW-IT-WORKS.md. List each deviation. Then answer plainly: does this agent understand its job — is the prompt (for AI agents) asking for the right judgment, with the right facts, in the right form, with the cascading variables from workspace_config and not hardcoded values? Quote the prompt lines that are weak or wrong.

### (b) Is it correct?
- Deterministic-before-AI: anything the model is asked to judge that the worker could have measured?
- Guardrails: read the guardrail file. Does it actually catch bad output, or does it only check shape? Name a bad output that would pass.
- Failure modes: what happens on timeout, null data, API 429, refusal, truncated JSON, bot-blocked site, zero reviews, no PSI? Trace each through the code; say "handled at X" or "unhandled → consequence".
- Tests: which of the above failure modes have a test? List the gaps as test names you would add.
- Data: does it write everything it computed, or does measured data die in agent_runs.output? Does anything downstream read a field that is always null?

### (c) Could it be better?
- Model and settings: is the model the cheapest that can do this job? For each AI agent state the current model/effort/maxTokens and a recommendation with reason (e.g. Analyst stays on Opus: human-read verdict; Design critique could move to Haiku 4.5 if vision quality holds — needs an eval). Where you recommend a downgrade, say what eval would prove it safe.
- Tokens: measure the real prompt size — build the prompt for one stored audit with the actual prompt function and print its character count and estimated tokens. Flag padding, repeated facts, and unneeded instructions.
- Duplicate work: fetches, parses or API calls done more than once per lead across agents (e.g. homepage fetched by two agents, PSI parsed twice, Place Details called twice).
- Unused data: fields computed or fetched that nothing reads (grep the consumers).
- Quality: the output a salesperson actually gets — is it specific to this business or generic? Judge from the stored outputs in Part 3.

### (d) What should change
Numbered, each with effort (S/M/L) and payoff (H/M/L). These feed Part 4.

## Part 3 — Live check on 3 real leads
Read-only. Using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/worker/.env (do not print them), select the 3 most recent audits with status='completed' and completed_at > '2026-10-04' whose business has a real website (website_kind = live, not fixture ids like 'fx-%'), preferring different categories. Use a throwaway script apps/worker/scripts/audit2-probe.ts (pattern: scripts/rescore-spot-check.ts, read-only, run with `npx tsx scripts/audit2-probe.ts` from apps/worker). For each lead print and then judge: business name, category, website, health, star, sellability + cap reason, every agent_runs row for that audit (agent, status, model_used, tokens, cost_cents, guardrail_passed), and each agent's stored output. Then write, per lead, a sanity verdict per agent: correct / questionable / wrong, with the specific value and why (e.g. "Conversion says no phone link; the homepage has tel: in the header — false negative, see site.ts:NN"). Open each of the 3 websites yourself (fetch the HTML) to check the deterministic measurements against reality.

If fewer than 3 qualifying audits exist, STOP and ask Joey this multiple-choice question before doing anything else: "Only N audits completed since Oct 4. Options: 1) run a fresh 3-mile search now (worker must be running; ~30¢ + AI), 2) use the 3 most recent audits regardless of date, 3) skip Part 3." Wait for his answer.

## Part 4 — Ranked fix list as brick stubs
Rank every (d) item across all agents by payoff ÷ effort, drop anything cosmetic, and write the top 8–12 as brick stubs in this exact shape so they can be issued as prompts without rework:

### RFL.FIX.3a — <short title>
- Why: one sentence, cites the finding.
- Change: files and the specific edit, in plain language.
- Guard: what must still be true (the test or check that proves it, including existing tests that must keep passing).
- Effort / payoff: S/M/L / H/M/L.
- Model: Opus 5.5 or Fable 5.1, with reason.

Continue 3b, 3c… Group dependent stubs and say the order. Items that need Joey's decision (scoring weights, model downgrades that need an eval, spend) go in a separate "Needs Joey's call" list with the options.

## Part 5 — Cost and quality summary
A half-page: today's real cost per lead from the stored agent_runs (not estimates), where the money goes, what the top 3 fixes would save or improve, and the one thing you would change first.

## Part 6 — Corrections to HOW-IT-WORKS.md
List anything in docs/HOW-IT-WORKS.md that the code contradicts (section, what it says, what is true, file:line). Do not edit the doc; RFL.FIX.3x will.

## Rules
- Evidence or it didn't happen: every claim carries file:line, a test name, a printed value, or a stored row id.
- Read the actual prompt text and guardrail code for every AI agent; do not summarise from HOW-IT-WORKS.md.
- Judge, don't describe: each (a)–(c) heading ends with a one-line verdict.
- Spend: Part 3 is read-only; no model calls, no searches, unless Joey picks option 1.
- Report length: as long as the evidence needs, no padding; expect 600–1,000 lines.

## Verification (report these)
1. `npm test` from root: files and test counts, pass/fail (baseline — nothing should change).
2. Part 1 table has 20 rows.
3. Part 2 has 14 agent sections, each with (a)(b)(c)(d).
4. Part 3 covers 3 leads (or records Joey's option choice).
5. Part 4 has ≥ 8 stubs, each with all five fields.
6. `git status` shows only docs/AUDIT-2026-10-07.md, AUDIT2_BRIEF.md and (optionally) apps/worker/scripts/audit2-probe.ts in the diff; no code files.
7. PR opened; include the number.

In the REPORT print Part 5 in full and the titles + effort/payoff of every Part 4 stub (one line each), nothing else from the doc.
