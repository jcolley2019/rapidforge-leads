# DESIGN_NOTES.md — RapidForge visual language v2 ("Glass")

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
