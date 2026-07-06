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
the live CSS; same backgrounds as core. Use only if the core dark text
tokens prove too soft on dense data screens.

---

# RapidForge visual language v2 ("Glass") — pre-rebrand baseline below

> Sprint 4, 2026-07-05. Supersedes PRD 7.1 per Joey's design-direction change.
> Governs every view. Apple-style modern product: generous whitespace, frosted
> glass, soft depth, one accent. Premium — marketable under RapidForgeAI.

## Reference points
Linear (restraint, keyboard-first chrome), Vercel dashboard (quiet data
density, mono numerics), Apple Settings/Music on macOS (frosted sidebars,
soft depth, one accent doing all the accent work). Glassmorphism is used
**structurally** — only on chrome that floats above content (top bar, rail,
cards, tab strip) — never as decoration on content itself.

## Color tokens (HSL triplets, CSS vars in `apps/web/src/index.css`)

| Token | Dark (default) | Light |
|---|---|---|
| `--background` | `228 20% 5%` | `220 30% 97%` |
| `--foreground` | `220 25% 94%` | `228 25% 10%` |
| `--muted-foreground` | `220 12% 60%` | `220 12% 42%` |
| `--primary` (accent) | `189 100% 50%` (#00d9ff) | `191 100% 34%` (AA on white) |
| `--card` (glass fill) | `228 16% 9%` | `0 0% 100%` |
| `--border` | `224 14% 16%` | `220 16% 88%` |
| `--glass` (surface tint) | `white / 0.04` | `white / 0.65` |
| `--glass-border` | `white / 0.08` | `228 25% 10% / 0.06` |
| status: active/waiting/complete/error | cyan / amber `38 92% 55%` / green `142 70% 45%` / red `0 84% 60%` | same hues, −8% lightness |

Cyan is the **only** accent: primary buttons, active nav, focus rings, live
pulses, hot-lead badges. Amber/green/red are functional status semantics, not
palette. Ambient background: two fixed radial gradients (cyan at 5% top-left,
deep blue at 4% bottom-right) so the glass has something to refract; imperceptible
as "a gradient."

## Typography
- **Inter Variable** for everything. Page title 24px/600/-0.025em; card title
  15px/600; body 14px/400; caption 12px; eyebrow 11px/500/+0.08em uppercase.
- **JetBrains Mono** ONLY for numeric data: scores, counts, phones, durations,
  money. Always `tabular-nums`. Never for headings or prose.

## Spacing & radii
- Base 4px scale. Page padding 32px; card padding 20–24px; section gap 24px;
  control height 40px; table row 52px. Whitespace is the layout tool — no
  hairline-dense grids.
- Radii: surfaces/cards `rounded-2xl` (16px) · controls/inputs `rounded-xl`
  (12px) · chips/badges/pills `rounded-full`. shadcn `--radius: 0.75rem`.

## Glass recipe (the `glass` utility)
- Dark: `background: hsl(var(--card) / 0.55)` + `backdrop-blur(20px)` +
  `border: 1px solid white/0.08` + inner top highlight
  `inset 0 1px 0 white/0.06`.
- Light: `background: white/0.65` + same blur + `border: black/0.06`.
- Chrome (top bar / rail / tab strip): blur 20px, fill opacity ~0.6 so content
  scrolls visibly beneath. Cards: same recipe + shadow (below). Never nest
  glass inside glass more than one level.

## Shadow recipe
- `--shadow-card` dark: `0 1px 0 rgba(255,255,255,.05) inset, 0 8px 30px rgba(0,0,0,.35)`
- `--shadow-card` light: `0 1px 2px rgba(16,24,40,.05), 0 8px 24px rgba(16,24,40,.08)`
- `--shadow-float` (popovers/drawers): double the y/blur. No colored shadows
  except the accent glow on live pulses: `0 0 12px hsl(189 100% 50% / .35)`.

## Motion (Framer Motion, presets in `apps/web/src/lib/motion.ts`)
- `spring.default` — `{ type:'spring', stiffness: 260, damping: 30 }` (layout,
  slide-in, tab underline).
- `spring.snappy` — `{ stiffness: 520, damping: 34 }` (micro: chips, buttons,
  count ticks).
- `spring.expand` — `{ stiffness: 300, damping: 36 }` (row expand — damped, no
  bounce).
- CSS transitions where Framer is overkill: 150ms micro / 250ms standard,
  easing `cubic-bezier(0.32, 0.72, 0, 1)`.
- Working-agent pulse: 2s soft opacity ring (CSS keyframe) + cyan glow.
- Everything respects `prefers-reduced-motion` (springs → opacity fades).

## Signature element
The **agent tab strip** on the Workspace view: a floating glass segmented
control with per-agent live status dots that breathe cyan while working — the
one place the product visibly "is" a team of agents. Everything around it
stays quiet.

## Theme
Dark is default. Toggle in top bar; preference persisted to
`localStorage('rapidforge-theme')`, applied as `.dark` class on `<html>`
before first paint (inline script in index.html — no flash).
