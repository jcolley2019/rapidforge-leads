/**
 * Help (RFL.HELP.4) — six walkthroughs and a glossary, written from
 * docs/HOW-IT-WORKS.md for the person running searches rather than the
 * developer. A sticky in-page nav jumps between sections; every section
 * ends with a "Go to" button into the view it describes.
 *
 * Deliberately hook-free: the tests render it and press its buttons
 * without a DOM.
 */
import {
  Download,
  Gauge,
  Globe,
  PanelRight,
  Search,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { viewDef, type ViewKey } from "@/views/views";

export interface HelpViewProps {
  onGoTo: (view: ViewKey) => void;
}

interface HelpSection {
  id: string;
  title: string;
  summary: string;
  icon: LucideIcon;
  goTo: ViewKey;
  body: ReactNode;
}

const STEPS =
  "list-decimal space-y-2 pl-5 text-sm leading-relaxed marker:font-mono marker:text-xs marker:text-primary";

const STAR_BANDS: Array<{ stars: number; health: string }> = [
  { stars: 5, health: "85+" },
  { stars: 4, health: "70–84" },
  { stars: 3, health: "50–69" },
  { stars: 2, health: "30–49" },
  { stars: 1, health: "< 30" },
];

const DRAWER_TABS: Array<[string, string]> = [
  ["Overview", "Status, scores, the issues found, the Analyst's verdict and the PDF report."],
  ["Audit", "What each agent measured, and what each AI call cost."],
  ["Builder Brief", "A rebuild spec for the new site: pages, copy, SEO and fixes."],
  ["Design Brief", "Structured brand, layout and photo choices for the demo generator."],
  ["Demo", "Builds a live demo site from the Design Brief."],
  ["Sales Script", "A talk track for the first call, with answers to likely objections."],
  ["History", "Every audit of this business, newest first."],
  ["Notes", "Your notes on the lead. They save as you type."],
  ["Screenshots", "Desktop and mobile captures of the homepage."],
];

const SECTIONS: HelpSection[] = [
  {
    id: "help-search",
    title: "Run a search",
    summary: "Pick a kind of business and an area; the agents do the rest.",
    icon: Search,
    goTo: "new-search",
    body: (
      <ol className={STEPS}>
        <li>
          Open <strong className="font-medium">New Search</strong>. Use{" "}
          <em>Zip / Radius</em> to center on a zip code, or <em>Map</em> to
          drop a pin anywhere.
        </li>
        <li>
          Choose a category. Categories are Google Places business types, such
          as plumber or electrician; type in the box to filter the list.
        </li>
        <li>
          Set the radius, from 1 to 25 miles. Optionally raise the minimum
          reviews or rating. Chains are excluded unless you include them.
        </li>
        <li>
          Press <strong className="font-medium">Run search</strong>. You land on
          the Workspace while Scout pulls up to 100 of the nearest matching
          businesses from Google.
        </li>
        <li>
          Filter then routes each business: no website or social only becomes a
          hot lead straight away, and every live site is audited, five at a
          time.
        </li>
        <li>
          Watch it work. The chip bar switches what you see: <em>All</em> shows
          the results table, which fills in as each lead is scored, and an
          agent's chip shows that agent's live activity. No refresh needed.
        </li>
        <li>
          Changed your mind? <strong className="font-medium">Cancel</strong>{" "}
          stops the queued audits and aborts the running ones. Leads already
          scored are kept.
        </li>
      </ol>
    ),
  },
  {
    id: "help-scores",
    title: "Read a score",
    summary: "Code measures the site, the scores are plain math, and AI only explains.",
    icon: Gauge,
    goTo: "leads",
    body: (
      <div className="space-y-5 text-sm leading-relaxed">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 rounded-xl border border-border px-4 py-3">
            <dt className="font-medium">Website Health</dt>
            <dd className="font-mono text-lg tabular-nums text-primary">0–100</dd>
            <dd className="text-muted-foreground">
              How well the site works: speed on phones and desktops, technical
              basics, platform, ways to contact, freshness and design.
            </dd>
          </div>
          <div className="space-y-1 rounded-xl border border-border px-4 py-3">
            <dt className="font-medium">Star grade</dt>
            <dd className="font-mono text-lg tabular-nums text-primary">1–5★</dd>
            <dd className="text-muted-foreground">
              Health turned into whole stars, so you can scan a list quickly.
            </dd>
          </div>
          <div className="space-y-1 rounded-xl border border-border px-4 py-3">
            <dt className="font-medium">Sellability</dt>
            <dd className="font-mono text-lg tabular-nums text-primary">0–100</dd>
            <dd className="text-muted-foreground">
              How good a prospect it is. Half comes from how weak the site is;
              the rest from reviews, rating, a listed phone, not being a chain
              and being open.
            </dd>
          </div>
        </dl>

        <div>
          <div
            className="grid grid-cols-5 overflow-hidden rounded-xl border border-border text-center"
            role="table"
            aria-label="Star grade by Website Health"
          >
            <div role="row" className="contents">
              {STAR_BANDS.map(({ stars }) => (
                <div
                  key={stars}
                  role="columnheader"
                  className="border-b border-r border-border py-1.5 font-mono text-sm tabular-nums text-primary last:border-r-0"
                >
                  {stars}★
                </div>
              ))}
            </div>
            <div role="row" className="contents">
              {STAR_BANDS.map(({ stars, health }) => (
                <div
                  key={stars}
                  role="cell"
                  className="border-r border-border py-1.5 font-mono text-xs tabular-nums text-muted-foreground last:border-r-0"
                >
                  {health}
                </div>
              ))}
            </div>
          </div>
          <p className="mt-2 text-muted-foreground">
            Health alone doesn't earn 4 or 5 stars. A site also has to pass the
            healthy-site rule, health of 70 or more <em>and</em> a mobile
            PageSpeed score of 60 or more. Sites that fail it stop at 3★,
            whatever their health. Mobile counts for more than desktop
            throughout, because that's where customers look.
          </p>
        </div>

        <p>
          No model ever sets a score. The worker measures the site, the scores
          come from fixed formulas, and AI writes the explanations on top. When
          a lead is 3★ or lower, scores 60+ on sellability, isn't a chain and
          wasn't blocked, the Analyst runs on its own and leaves a verdict on
          the lead's Overview tab.
        </p>
        <p>
          Two cases skip the audit. <strong className="font-medium">No website</strong>{" "}
          or <strong className="font-medium">social only</strong> means a hot
          lead at sellability 95: there's nothing to audit, and it's the easiest
          pitch. <strong className="font-medium">Site broken — urgent</strong>{" "}
          means the site is down or erroring: health 10, 1★.
        </p>
      </div>
    ),
  },
  {
    id: "help-drawer",
    title: "Open the lead drawer",
    summary: "Everything about one lead, and the deliverables you generate for it.",
    icon: PanelRight,
    goTo: "leads",
    body: (
      <div className="space-y-5 text-sm leading-relaxed">
        <p>
          Click any lead in Leads, Pipeline or the Workspace results table, or
          press Ctrl K and type its name. The drawer opens on the right with
          these tabs:
        </p>
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2">
          {DRAWER_TABS.map(([tab, what]) => (
            <div key={tab} className="contents">
              <dt className="font-medium">{tab}</dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
        <p>
          Builder Brief, Design Brief and Sales Script unlock once the audit
          completes. The first generate saves the result, and opening it again
          later is free. <strong className="font-medium">Regenerate</strong>{" "}
          writes a fresh one and pays for a new AI call.
        </p>
        <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-border">
          {(
            [
              ["Full audit", "≈ 5–6¢"],
              ["Builder Brief", "≈ 12¢"],
              ["Analyst", "≈ 3¢"],
            ] as const
          ).map(([what, cost]) => (
            <div
              key={what}
              className="border-r border-border px-4 py-2.5 last:border-r-0"
            >
              <p className="text-xs text-muted-foreground">{what}</p>
              <p className="font-mono text-base tabular-nums">{cost}</p>
            </div>
          ))}
        </div>
        <p>
          <strong className="font-medium">Download audit report</strong> on the
          Overview tab gives you a two-page report to send the prospect.{" "}
          <strong className="font-medium">Re-audit</strong> at the top of the
          drawer runs a fresh audit, and the scores update in place when it
          finishes.
        </p>
      </div>
    ),
  },
  {
    id: "help-export",
    title: "Export",
    summary: "Take leads out as a spreadsheet, or work many at once.",
    icon: Download,
    goTo: "leads",
    body: (
      <ol className={STEPS}>
        <li>
          Open <strong className="font-medium">Leads</strong>. It lists every
          lead from every search, best prospects (highest sellability) first.
        </li>
        <li>
          Narrow the list with the filter bar: website, platform, status, and
          sellability or health ranges.
        </li>
        <li>
          Press <strong className="font-medium">Export CSV</strong>. You get
          the filtered list, or only the rows you've ticked. The file is built
          in your browser; nothing is sent anywhere.
        </li>
        <li>
          Tick rows to bring up the bulk bar. <em>Set status</em> moves them
          all at once; <em>Re-audit</em> audits them again, and{" "}
          <em>Force fresh</em> skips the 30-day cache.
        </li>
        <li>
          For a board view, open{" "}
          <strong className="font-medium">Pipeline</strong>: one column per
          status, from New to Sold or Dead. Drag a card to another column to
          change its status.
        </li>
      </ol>
    ),
  },
  {
    id: "help-demo",
    title: "Build a demo",
    summary: "Turn a lead's Design Brief into a live demo site you can show them.",
    icon: Globe,
    goTo: "pipeline",
    body: (
      <div className="space-y-4 text-sm leading-relaxed">
        <ol className={STEPS}>
          <li>
            Open a lead from Pipeline or Leads and go to its{" "}
            <strong className="font-medium">Demo</strong> tab.
          </li>
          <li>
            Check the subdomain. It's prefilled from the business name and
            becomes the demo's address under demos.rapidforge.ai.
          </li>
          <li>
            Press <strong className="font-medium">Build demo</strong>. The
            Design Brief goes to the rapidforge-demos generator (it's written
            first if the lead doesn't have one yet), which builds five visual
            variants and deploys them. It takes one to two minutes, and the
            build log streams in as it goes.
          </li>
          <li>
            When it's ready, the big link is the public demo: Open it or Copy
            it. The small link underneath is the Vercel preview, which needs a
            Vercel login. The time below tells you when it was last built.
          </li>
          <li>
            If you see "public link goes live once DNS is set up", the demo is
            built but its address isn't pointing at it yet. Use the preview
            meanwhile.
          </li>
          <li>
            <strong className="font-medium">Rebuild</strong> builds it again
            from the current brief. If a build fails, the error shows with{" "}
            <em>Try again</em>.
          </li>
        </ol>
        <p className="text-muted-foreground">
          Demos are built on the worker's machine and need its DEMOS_DIR
          setting pointed at the rapidforge-demos checkout. Without it, every
          build fails straight away.
        </p>
      </div>
    ),
  },
  {
    id: "help-settings",
    title: "Settings",
    summary: "Tell the agents who you are and what you sell. Do this first.",
    icon: SlidersHorizontal,
    goTo: "settings",
    body: (
      <ol className={STEPS}>
        <li>
          Open <strong className="font-medium">Settings</strong> and fill in
          the six cascading variables: your offer, target industry, ideal
          website traits, sales tone, your location and your brand.
        </li>
        <li>
          Press <strong className="font-medium">Save variables</strong>. Every
          AI deliverable reads them: the Analyst's verdict, the Builder Brief
          and the Sales Script. Change one and everything written afterwards
          follows.
        </li>
        <li>
          Anything you leave blank falls back to a generic default, so the
          writing is only as specific as what you put here.
        </li>
        <li>
          Briefs and scripts already saved keep their old wording. Regenerate
          one to pick up new settings.
        </li>
        <li>
          Search defaults prefill New Search with your usual radius and
          category. Appearance switches between dark and light.
        </li>
      </ol>
    ),
  },
];

const GLOSSARY: Array<[string, string]> = [
  ["Hot lead", "A business with no website, or only a social profile. Sellability 95, never audited."],
  ["Provisional audit", "Placeholder scores because bot protection blocked the audit: health 50, sellability capped at 55."],
  ["Bot protection", "A firewall page, such as Cloudflare's \"Just a moment…\", that answers instead of the real site."],
  ["Sellability cap", "A ceiling applied after the math: chain 40, provisional 55, healthy site 55."],
  ["PageSpeed (PSI)", "Google's free speed test. RapidForge reads its mobile score for every site."],
  ["Core Web Vitals", "Google's page-experience measures: how fast the main content shows, how much it jumps, how long it freezes."],
  ["Builder site", "A site on Wix, GoDaddy or Squarespace. It scores low on platform and carries a Builder site badge."],
  ["CTA", "Call to action: a button or link such as \"Call now\" or \"Book online\"."],
  ["Cascading variables", "The six Settings fields that every AI deliverable reads."],
  ["30-day cache", "A finished audit less than 30 days old is reused instead of re-run, unless you force a fresh one."],
  ["Template", "The plain, code-written text an agent falls back to when AI is off or fails."],
  ["AEO", "Answer engine optimization: writing pages so AI assistants can quote them. Every Builder Brief covers it."],
];

export function HelpView({ onGoTo }: HelpViewProps) {
  const nav = [
    ...SECTIONS.map(({ id, title }) => ({ id, title })),
    { id: "help-glossary", title: "Glossary" },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
          Account
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Help</h1>
        <p className="text-sm text-muted-foreground">
          How RapidForge Leads works, in six walkthroughs.
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[10.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <nav
          aria-label="Help sections"
          className="sticky top-0 z-10 -mx-1 mb-4 bg-background/95 px-1 py-2 lg:top-0 lg:m-0 lg:bg-transparent lg:p-0"
        >
          <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
            {nav.map(({ id, title }) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 lg:rounded-xl lg:border-0 lg:py-1.5 lg:text-sm lg:hover:bg-accent/60"
                >
                  {title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-4">
          {SECTIONS.map((section) => (
            <HelpSectionCard
              key={section.id}
              section={section}
              onGoTo={onGoTo}
            />
          ))}

          <Card id="help-glossary" className="scroll-mt-16 lg:scroll-mt-4">
            <CardHeader>
              <CardTitle className="text-base">
                <h2>Glossary</h2>
              </CardTitle>
              <CardDescription>Words you'll meet in audits and briefs.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-3 text-sm leading-relaxed sm:grid-cols-2">
                {GLOSSARY.map(([term, meaning]) => (
                  <div key={term}>
                    <dt className="font-medium">{term}</dt>
                    <dd className="text-muted-foreground">{meaning}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function HelpSectionCard({
  section,
  onGoTo,
}: {
  section: HelpSection;
  onGoTo: (view: ViewKey) => void;
}) {
  const { id, title, summary, icon: Icon, goTo, body } = section;
  const target = viewDef(goTo);
  const TargetIcon = target.icon;
  return (
    <Card id={id} className="scroll-mt-16 lg:scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-primary" aria-hidden />
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {body}
        <div className="border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => onGoTo(goTo)}>
            <TargetIcon aria-hidden />
            Go to {target.label}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
