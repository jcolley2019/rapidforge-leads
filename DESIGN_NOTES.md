# DESIGN_NOTES.md — RapidForge visual language

## 0. JoeyC brand palette (extracted 2026-07-05 — Step 0 of the rebrand)

> Canonical source of truth for every color below. Three sources were read
> and reconciled; **all values verified identical** across (a) the JoeyC.ai
> site source at `C:\dev\CLAUDE CODE MC` — `public/brand.html` (the brand
> guide, stated verbatim), `src/components/command-center/BrandGuide.tsx`,
> and the Tailwind v4 `@theme` in `src/index.css` — and (b) the **LIVE**
> deployed stylesheet at `https://joeyc.ai/assets/index-DHeanrOX.css`.
> The old static prototype (c) `C:\dev\joeyc-ai\index.html` uses a
> superseded cyan system (`#00CFFF` on `#06080F`) — rejected per the
> live-site-wins rule. No colors copied from third-party products.

### Core system (dark — the brand's default)

| Role | Hex | Source |
|---|---|---|
| Primary (electric blue) | `#1a8fff` | brand.html `--primary` = live CSS `--color-primary` |
| Primary hover | `#3da0ff` | brand.html `--primary-hover` = live |
| Accent (deep blue) | `#0a3aad` | brand.html `--accent` = live |
| Background | `#0a0a0f` | brand.html `--bg` = live |
| Card | `#0c1020` | brand.html `--bg-card` = live |
| Section | `#080b16` | brand.html `--bg-section` = live |
| Text primary | `#e8edf5` | brand.html `--text-primary` = live |
| Text secondary | `#8892a4` | brand.html `--text-secondary` = live |
| Border | `#0f1a33` | brand.html `--border` = live |
| Border hover | `#1a3366` | brand.html `--border-hover` = live |
| Glow | `#1a8fff` | brand.html `--glow` = live (same as primary) |
| Success | `#22c55e` | brand.html `--success` (guide swatch) |
| Error | `#ef4444` | brand.html `--error` (guide swatch) |
| Warning | `#eab308` | brand.html `--warning` (guide swatch) |
| Divider deep stop | `#04133d` | brand.html divider gradient + BrandGuide.tsx |

### Luxe system (light — gold/cream, the brand's light flavor)

| Role | Hex | Source |
|---|---|---|
| Primary (old gold) | `#b8860b` | brand.html `--luxe-primary` = live `.luxe-mode` |
| Primary hover | `#d4a017` | brand.html `--luxe-hover` = live |
| Accent | `#8b6914` | brand.html `--luxe-accent` = live |
| Background (cream) | `#faf6f0` | brand.html `--luxe-bg` = live |
| Card | `#f5efe6` | brand.html `--luxe-card` = live |
| Section | `#ede5d8` | site + live `.luxe-mode --color-bg-section` (not in brand.html :root) |
| Text | `#1a1008` | brand.html `--luxe-text` = live |
| Text secondary | `#3d2b1f` | brand.html `--luxe-text-sec` = live |
| Border | `#d4c5a9` | brand.html `--luxe-border` = live |
| Border hover | `#b8a080` | site + live `.luxe-mode --color-border-hover` |
| Glow | `#d4a017` | site + live `.luxe-mode --color-glow` |

### High-contrast dark variant (page-scoped on the live site)

`text #ffffff · text-secondary #94a3b8 · border #1e2a4a · border-hover
#2a3d6a` — a secondary dark block in both source `index.css` (l.493) and
the live CSS; same backgrounds as core. In RapidForge this is the
`.dense-surface` scope for dark-mode tables/feeds (see §4).

## 0.1 RapidForge product-UI refinements (S6, 2026-07-05 — Joey's review of v3)

The §0 tables above remain the canonical **brand** record. The product UI
diverges from it in two deliberate ways as of Sprint 6:

### Dark accent, brightened one step for UI legibility

| Role | Was (brand) | Now (product UI) | Contrast on `#0a0a0f` / `#0c1020` |
|---|---|---|---|
| Primary | `#1a8fff` | **`#3da0ff`** (hsl 209 100% 62%) | 7.2:1 / 6.9:1 (was 6.0 / 5.8) |
| Primary hover | `#3da0ff` | **`#66b5ff`** (hsl 209 100% 70%) | 9.1:1 / 8.7:1 |

`#3da0ff` was chosen from the tested `#2e9bff–#4dabff` range (6.8:1 → 8.1:1
on canvas): it's the strongest step up that is already a documented brand
value (the old hover), so the palette stays coherent — the UI primary is
the brand's hover tone, and one new lighter hover (`#66b5ff`, same
209/100% hue-sat axis) is minted above it. **The logotype and
marketing-strength elements may keep `#1a8fff`** (the TopBar logotype is
foreground-colored and unaffected; map overlay pin/circle stays `#1a8fff`,
which reads better on the pale default basemap).

### Light mode: neutral gray + blue (cream/gold retired)

The luxe gold/cream system is **retired from the product UI entirely** (it
remains a joeyc.ai brand asset). Light mode is now a neutral gray canvas
with white cards and the SAME blue family as dark, using the deeper brand
tones where contrast on white demands it:

| Role | Hex | Notes |
|---|---|---|
| Background | `#f3f4f6` | soft gray canvas — deliberately not bright white |
| Card | `#ffffff` | white cards on gray |
| Secondary / muted fill | `#f3f4f6` | fills inside white cards match the canvas |
| Raised / hover fill | `#e5e7eb` | |
| Text primary | `#1e293b` | dark slate |
| Text secondary | `#475569` | 7.6:1 on white |
| Border | `#d1d5db` | gray; borders still carry the structure |
| Border hover / emphasis | `#9ca3af` | |
| Primary | `#1a8fff` | deeper brand blue holds on white (buttons, active nav, rings) |
| Primary hover | `#0077e6` | hover darkens on light (same 209/100% axis) |
| Deep accent | `#0a3aad` | small accent text on white where 4.5:1+ is required (9.5:1) |
| Status | `#22c55e` / `#ef4444` / `#eab308` | unchanged functional semantics |

No gold anywhere. Glass fill stays white/0.88; glass border and shadows are
slate-tinted (`#0f172a`-based rgba) instead of espresso; the ambient wash is
a faint blue radial instead of gold.

## 0.2 Light-mode contrast pass (S7, 2026-07-06 — Joey's review of S6)

S6's white-on-`#f3f4f6` read as one flat field — cards didn't separate from
the canvas. S7 darkens the canvas and lets a soft border + shadow do the
popping, so a squint test shows distinct rectangles. **Dark mode is
unchanged.**

| Role | S6 | S7 | Notes |
|---|---|---|---|
| Canvas (`--background`) | `#f3f4f6` (96% L) | **`#EEF1F5`** (95% L, cooler) | one step darker so white lifts off it |
| Sidebar (`--sidebar`, new) | (= canvas) | **`#E9EDF2`** | rail sits one step deeper than canvas |
| Card | `#ffffff` | `#ffffff` | unchanged — cards stay pure white |
| Card border (`--card-border`, new) | (= `--border` `#d1d5db`) | **`#DCE1E8`** | soft edge; canvas contrast + shadow carry the separation |
| Card shadow (`--shadow-card`) | `0 1px 2px /0.05` | **`0 1px 2px /0.06, 0 4px 12px /0.07`** | a real soft lift |
| `--border` / `--input` | `#d1d5db` | `#d1d5db` | **kept** — table dividers and form fields stay crisp |

`--card-border` is a NEW token distinct from `--border`: only `.card-panel`
uses it, so lightening the card edge never softens the S5.5 full-opacity
table dividers or input outlines (those keep `#d1d5db`). In dark mode both
`--card-border` and `--sidebar` are set to the existing dark values, so the
dark theme renders identically to S6.

---

# RapidForge visual language v3.1 — JoeyC brand (S5.5 rebrand + S6 refinements, 2026-07-05)

> Supersedes v2 "Glass". Governs every view. The product wears the JoeyC
> brand: electric-blue dark by default, neutral gray + blue light (§0.1),
> bordered containers, glass only where something truly floats.

## 1. Color

- Tokens are the §0 palette as refined by §0.1 — CSS vars in
  `apps/web/src/index.css` as HSL triplets (exact conversions of the
  documented hexes).
- **Dark (default):** `#0a0a0f` canvas · `#0c1020` cards · 1px blue-tinted
  borders (`#0f1a33` base, `#1a3366` emphasis/hover) · text `#e8edf5` /
  `#8892a4` · accent `#3da0ff` (hover `#66b5ff`) — brightened one step from
  the `#1a8fff` brand blue for UI legibility (§0.1); the logotype and
  marketing-strength elements may keep `#1a8fff`. The accent does ALL
  accent work: primary buttons, active nav, focus rings, live pulses,
  hot-lead badges.
- **Light (neutral gray + blue, S6 → contrast pass S7 §0.2):** `#EEF1F5`
  soft gray canvas (deliberately not bright white; darker than S6's
  `#f3f4f6` so white cards pop) · `#E9EDF2` sidebar (one step deeper) ·
  **white** cards with a `#DCE1E8` edge + soft lift shadow · `#d1d5db` gray
  borders on dividers/inputs (`#9ca3af` emphasis/hover) · dark slate text
  `#1e293b` /
  `#475569` · the same blue family as dark using the deeper brand tones —
  primary `#1a8fff` (hover `#0077e6`), `#0a3aad` for small accent text
  where contrast on white demands it. `#f3f4f6` serves as secondary/muted
  fills inside white cards, `#e5e7eb` as hover/raised fills. **No gold
  anywhere** — the luxe cream/gold system is retired from the product UI
  (§0.1).
- **Status (both themes, per guide):** success `#22c55e` · error `#ef4444`
  · warning `#eab308`. These are functional semantics, never palette.
- **Dense data surfaces (dark only):** the `.dense-surface` scope flips
  text to `#ffffff`/`#94a3b8` and borders to `#1e2a4a` (the live site's
  high-contrast block) for tables and activity feeds. Never page-wide.

## 2. Typography (brand rule)

- **Space Grotesk** for ALL UI and body copy. Page title 24px/600; card
  title 15px/600; body 14px; caption 12px; eyebrow 11px/500/+0.08em upper.
- **JetBrains Mono** ONLY for numeric data: scores, counts, phones,
  durations, money. Always `tabular-nums`. Never headings or prose.
- **Orbitron** appears in EXACTLY ONE place: the RapidForge logotype in the
  top bar (`font-display`, 700, +0.08em). Never for headings, never for UI.
- Delivery: Google Fonts links in `index.html` (same mechanism as
  joeyc.ai). Weights: Space Grotesk 400–700, JetBrains Mono 400/500/700,
  Orbitron 700 only.

## 3. Containers (the v3 structural rule)

- **Every content region lives in a bordered card** — `.card-panel`
  (bg-card, 1px border-border, rounded-2xl, minimal shadow). Nothing
  floats on bare canvas; the canvas-vs-card contrast (`#0a0a0f` vs
  `#0c1020`, cream vs white) plus the 1px border IS the separation.
  Shadows are near-invisible; borders carry the structure.
- Chrome (top bar, left rail) is **solid** `bg-background/95` with a 1px
  border edge — not glass, not a card.
- **Glass exists ONLY on overlays**: the lead drawer and the cmd-K palette
  (`.glass` = tinted fill + blur 20px + 1px border + `--shadow-float`).
  Nothing else blurs.
- Radii: surfaces `rounded-2xl` (16px) · controls `rounded-xl` (12px) ·
  chips/badges `rounded-full`. shadcn `--radius: 0.75rem`.

## 4. Density

- Base 4px scale. Page padding 32px; card padding 20–24px; section gap 24px;
  control height 40px.
- **Tables are compact (S5.5):** cell padding `px-3 py-[7px]` (~40% less
  than v2's py-3), row height ≈ 38–40px, full-opacity 1px row dividers
  (`border-border`), phone/state columns single-line always (nowrap +
  reserved widths). Tables and feeds sit inside `.dense-surface` in dark
  mode.

## 5. Sidebar

Grouped sections with uppercase micro-headers (11px mono, +0.2em,
muted): **PROSPECTING** (Dashboard, Workspace, New Search) ·
**PIPELINE** (Pipeline, Leads) · **INTELLIGENCE** (Agents, Analytics) ·
**ACCOUNT** (Settings). Active item = accent pill (spring `layoutId`).

## 6. Motion

Framer springs unchanged from v2 (`apps/web/src/lib/motion.ts`):
`spring.default` 260/30 (layout, slide-in, tab underline) ·
`spring.snappy` 520/34 (micro) · `spring.expand` 300/36 (row expand).
CSS transitions 150/250ms, easing `cubic-bezier(0.32, 0.72, 0, 1)`.
Working-agent pulse: 2s breathing ring in the accent color.
Everything respects `prefers-reduced-motion`.

## 7. Map

Google's **default basemap styling in both themes** — no JSON tinting, no
theme restyling of the canvas (v3 reverses v2's tinted map). RapidForge
owns only its own layers: pin, radius circle (stroke/fill `#1a8fff`),
and the bordered readout chip.

## 8. Theme

Dark is the brand default. Toggle in top bar; persisted to
`localStorage('rapidforge-theme')`, applied as `.dark` on `<html>` before
first paint (inline script in index.html — no flash).
