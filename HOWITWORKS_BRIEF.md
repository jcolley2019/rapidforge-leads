# RFL.DOCS.1 — docs/HOW-IT-WORKS.md

## Goal
Write docs/HOW-IT-WORKS.md: a plain-language explanation of what RapidForge Leads does and how, derived from the CODE as it is today — not from RapidForge-PRD.md (the PRD is older than the code in several places; where they differ, the code wins and you note the difference). The reader is Joey, the owner: not a professional developer, knows the product idea cold, wants to understand what each agent does, how, and what it costs. No code changes in this brick. Branch rfl-docs-1 off main, PR to main, stage by explicit path, never -A.

## Sources to read (targeted, in this order)
- CLAUDE.md §4.1 model lineup, §4.2 scoring doctrine, §6 agent conventions, §8 cost discipline
- apps/worker/src/orchestrator.ts, queue.ts, events.ts
- apps/worker/src/agents/*.ts (all 13 agents incl. design-brief.ts, money-facts.ts, on-demand.ts), agents/prompts/*.ts, agents/guardrails/*.ts and both README.md files there
- apps/worker/src/lib/ (probe, site, psi, places client, ai.ts for pricing/cost math, screenshots, pdf-report, yelp stub)
- packages/shared/src/scoring.ts, schemas.ts, design-brief.ts, events
- supabase/migrations/*.sql (table and column names — do not paraphrase names; use the real ones)
- apps/worker/src/http.ts (routes the web app calls)
- apps/web/src pages/components only enough to name the screens (Search, Leads, Pipeline, Settings, drawer tabs)
- docs/AUDIT-2026-10.md §(b) agent map and §(e) model split — as a cross-check, but describe today's code, not the audit's snapshot (Sonnet 4.6 is gone; models are per CLAUDE.md §4.1)

## Document structure (use these exact H2 headings)
1. ## What RapidForge Leads does — one paragraph, plain English.
2. ## How a search runs, start to finish — numbered walkthrough from the user typing a category + location to the Sales Summary: which job types the queue creates, which agents run in which order (and which run in parallel), what is deterministic vs AI, what gets written where. Include one ASCII flow diagram and a table "Which table holds what" (searches, businesses, search_results, audits, agent_runs, jobs, usage_events, workspace_config, plans — real column names for the important fields).
3. ## Scoring in one page — Health 0–100 → star grade, Sellability 0–100 with the current weights and caps from scoring.ts, the special routing (no website / social-only / dead / blocked / chain), and the exact Analyst auto-run condition. State the weights as numbers read from the file.
4. ## The 13 agents — one subsection (### N. Name) per agent in pipeline order: Scout, Filter, Health, Conversion, Presence, Traffic, Design, Reputation, SEO, Scorer, Analyst, Builder Brief, Sales Summary. Also cover Design Brief (the JSON brief from RFL.BRIEF.7) as "### 12b. Design Brief" since rapidforge-demos consumes it. Each subsection has the same fields, in this order:
   - Job: one sentence.
   - Measures deterministically: bullet list of concrete signals with the source (PSI field, HTML check, Places field…).
   - What the AI judges: what the model is asked to decide or write; "none" for deterministic-only agents. Name the prompt file.
   - Model and settings: model ID, effort, maxTokens, and any env switch (e.g. AI_SUMMARIES=haiku). Say "deterministic template by default" where that is true.
   - Guardrails: what the self-check verifies and what happens on failure (name the guardrail file).
   - Inputs → outputs: what it reads, what it writes (table.column or agent_runs.output), and the Realtime events it emits.
   - Who reads it downstream: the agents, screens, exports, or the demos repo.
   - Typical cost per lead: from ai.ts pricing and the agent's maxTokens/typical usage; "$0 (no AI)" where true.
   - Known gaps: anything the code clearly leaves unfinished (stubs, always-null fields, unused columns) — facts only, no fixes; the audit brick handles fixes.
5. ## What the web app shows — the screens and drawer tabs and which data each reads; the on-demand actions (Analyst, Builder Brief, Sales Summary, Design Brief, PDF, re-audit, cancel) and their routes.
6. ## Cost per lead — a table summing the per-agent costs for the three paths: no-website hot lead, audited lead without Analyst, audited lead with Analyst + on-demand Brief + Sales Summary. Show the arithmetic.
7. ## Glossary — every term a non-developer would stumble on (PSI, CWV, CrUX, NAP, GBP, guardrail, provisional audit, sellability cap, job poller, Realtime, workspace_config cascading variables, etc.), one line each.
8. ## Where PRD and code differ — short table: topic, what the PRD says, what the code does.

## Rules
- Every factual claim about behaviour must come from a file you read; cite the file path in parentheses the first time each agent or mechanism is described (e.g. "(apps/worker/src/agents/filter.ts)"). No invented numbers; if a value is computed at runtime and you cannot state it, say how it is derived.
- Plain language first, then the precise term in parentheses. Short sentences. No marketing tone.
- Target 1,200–2,000 lines of markdown is NOT required — aim for complete, not long; roughly 400–700 lines is expected.
- Do not edit CLAUDE.md, RapidForge-PRD.md, or any code.

## Verification (do these, report results)
1. Agent count: the document has exactly 13 "### N." subsections plus "### 12b. Design Brief", in pipeline order.
2. Model names: grep the doc for "4.6", "Opus 4.7", "GPT" — must be zero hits except inside the "Where PRD and code differ" table if the PRD mentions them. Every model ID in the doc must appear in CLAUDE.md §4.1.
3. Weights: the Sellability weights and caps in §3 match packages/shared/src/scoring.ts and CLAUDE.md §4.2 (print the scoring.ts lines you used).
4. Tables: every table name in §2 exists in supabase/migrations/*.sql (grep "create table" and list the matches).
5. Routes: every route named in §5 exists in apps/worker/src/http.ts (grep and list).
6. npx tsc --noEmit is not needed (no code changed); run `git status` to confirm only docs/HOW-IT-WORKS.md and HOWITWORKS_BRIEF.md are in the diff.
7. Open the PR (title "RFL.DOCS.1 HOW-IT-WORKS.md") and include the PR number in the report.

Print the full text of the "## Cost per lead" and "## Where PRD and code differ" sections in the REPORT (they are short and I want to read them without opening the file).
