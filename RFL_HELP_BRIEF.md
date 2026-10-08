# RFL.HELP.4 — In-app Help page + first-run coaching tips

Work directly on main in C:\dev\rapidforge-leads. One problem per commit, explicit-path
staging. No schema changes, no migrations, no worker changes. Web tests run with
`npm run test -w apps/web` (currently 93) — counts must not drop; typecheck with
`npm run typecheck -w apps/web`. Load the frontend-design skill before touching any UI.
Match the existing look: Card/CardHeader/CardTitle/CardDescription from
apps/web/src/components/ui, the uppercase 11px section micro-header + h1 pattern used
in SettingsView, lucide icons, no new dependencies.

Dev servers are NOT running. Before the live check in item 6 start them in two
background terminals: `npm run dev -w apps/worker` (:8788) and `npm run dev -w apps/web`
(:5173). Leave them running when you finish.

## 1. Help view (commit 1)

- apps/web/src/views/views.ts: add `"help"` to ViewKey; add
  `{ key: "help", label: "Help", icon: CircleHelp }` to VIEWS (lucide `CircleHelp`);
  add `"help"` to the "Account" group in RAIL_GROUPS after "settings".
- apps/web/src/App.tsx: `case "help": return <HelpView onGoTo={setView} />;`
- New apps/web/src/views/HelpView.tsx. Micro-header "Account", h1 "Help", one-line
  subtitle "How RapidForge Leads works, in five walkthroughs." Then a sticky
  in-page nav (anchor links) and these sections, each a Card. Write the copy from
  docs/HOW-IT-WORKS.md, in plain second-person how-to voice, 4–8 numbered steps or
  short paragraphs per section, no code paths, no table dumps. Every section ends
  with a "Go to …" link button that calls `onGoTo(<ViewKey>)` where a view exists.
  1. **Run a search** — New Search: category (Google Places type), zip or map pin,
     radius 1–25 mi; what happens next (Scout → Filter → audits five at a time);
     the Workspace chip bar and event feed; Cancel. Go to: new-search.
  2. **Read a score** — Website Health 0–100, star grade 1–5, Sellability 0–100;
     "code measures, scores are math, AI only explains"; mobile PSI weighs more
     than desktop; sites that fail the healthy rule (health ≥ 70 AND mobile ≥ 60)
     are capped at 3★; when the Analyst runs automatically (≤ 3★, sellability ≥ 60,
     not chain/provisional); what "no website / social only → hot lead" and
     "Site broken — urgent" mean. Go to: leads.
  3. **Open the lead drawer** — tabs Overview / Audit / Builder Brief / Design Brief /
     Sales Script / Demo / History / Notes / Screenshots; Builder Brief, Design Brief
     and Sales Script unlock after the audit completes; Regenerate rewrites and costs
     a new AI call; approximate costs (full audit ≈ 5–6¢, Builder Brief ≈ 12¢,
     Analyst ≈ 3¢); the PDF report. Go to: leads.
  4. **Export** — Leads view CSV export (built in the browser), bulk status change,
     bulk re-audit; Pipeline kanban by status. Go to: leads.
  5. **Build a demo** — the Demo tab's "Build demo" button hands the Design Brief to
     the rapidforge-demos generator; what the status/URL fields mean; it needs the
     worker's DEMOS_DIR configured. Go to: pipeline.
  6. **Settings** — the cascading variables (brand, location, offer, tone…) feed every
     AI deliverable; fill them in first. Go to: settings.
  Finish with a short "Glossary" card (8–12 terms from the doc's Glossary section).
- apps/web/src/components/CommandPalette.tsx: Help must appear like the other views
  (it iterates VIEWS — verify; if it hardcodes, add it).
- apps/web/src/components/layout/TopBar.tsx: add a `CircleHelp` icon button
  (aria-label "Help", tooltip/title "Help") next to the existing analytics button,
  wired through a new `onOpenHelp` prop from App.tsx → `setView("help")`.

## 2. Coaching tips (commit 2)

- New apps/web/src/lib/coaching.ts:
  - `coachingKey(userId: string)` → `rapidforge-coaching:${userId}`
  - `isDismissed(userId, tipId)`, `dismiss(userId, tipId)`, `resetAll(userId)` —
    localStorage, try/catch around every read/write (same style as theme.ts and
    search-defaults.ts). Stored value: JSON array of dismissed tip ids.
  - `TIP_IDS` const: "dashboard" | "new-search" | "workspace" | "leads" | "pipeline" |
    "drawer".
- New apps/web/src/components/CoachingTip.tsx: a dismissible callout
  (`role="note"`, lightbulb icon, title, 1–2 sentence body, optional "Learn more →"
  that calls onOpenHelp, and an X button aria-label "Dismiss tip"). Reads userId from
  useAuth (signed_in → session.user.id; unconfigured preview → "preview"). Renders
  nothing when dismissed. Uses the existing motion helpers in lib/motion.ts only if
  they fit; no new animation library.
- Place one tip at the top of each: DashboardView ("Start with a search…"),
  NewSearchView ("Pick a category and an area…"), WorkspaceView ("Watch the agents
  work…"), LeadsView ("Open any row for the drawer; export CSV from here…"),
  PipelineView ("Drag or set status…"), and LeadDrawer Overview tab ("Builder Brief,
  Design Brief and Sales Script unlock when the audit completes…"). Copy is yours;
  keep each under 30 words.
- HelpView and CoachingTip need a way to open Help: pass `onOpenHelp` down from
  App.tsx to those views, or expose a tiny `useNavigate`-style context — pick whichever
  touches fewer files; say which in the REPORT.

## 3. Settings additions (commit 3)

- apps/web/src/views/SettingsView.tsx: new Card "Help & coaching" below the existing
  cards: a sentence, a button "Open Help" (→ needs onGoTo prop from App.tsx), and a
  button "Reset coaching tips" that calls `resetAll(userId)` and shows a 2-second
  "Tips reset" flash using the existing flash pattern.

## 4. Tests (commit 4)

- apps/web/src/lib/coaching.test.ts: dismiss → isDismissed true; resetAll clears;
  per-user isolation (user A's dismissal doesn't hide user B's tip); corrupt JSON in
  storage is treated as nothing dismissed.
- apps/web/src/components/CoachingTip.test.tsx: renders; X dismisses and it is gone on
  re-render; dismissed tip does not render.
- apps/web/src/views/HelpView.test.tsx: all six section headings and the Glossary
  render; a "Go to" button calls onGoTo with the right key.

## 5. Docs (commit 5)

- docs/HOW-IT-WORKS.md: in "What the web app shows", add the Help row to the views
  table and a Demo tab row to the drawer table (it is missing today), and one
  paragraph on coaching tips (storage key, reset location).

## 6. Gate + live check

- `npm run typecheck -w apps/web`, `npm run test -w apps/web` (≥ 93 + new tests),
  `npm test` at root (shared 89 / worker 569 unchanged).
- Start the dev servers (see top), then with Claude in Chrome at http://localhost:5173
  (Joey approves the sign-in): confirm Help in the rail under Account, every "Go to"
  button navigates, the top-bar ? opens Help, a tip shows on Dashboard, dismiss it,
  reload — still gone; Settings → Reset coaching tips → reload — it is back. One
  half-scale screenshot of the Help page in the REPORT as a description, not an image.
- `git push` after the last commit.

Print your report between the lines "=== REPORT — RFL.HELP.4 ===" and "=== END REPORT ===":
commits (sha + one line each), spec departures with reasons, verification table
(typecheck / web tests before→after / root tests / each live check pass-fail),
git status, up to three "worth knowing" notes. No diffs.
