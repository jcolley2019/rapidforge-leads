/**
 * DemoTabView renders each of the four demo states from props (RFL.DEMO.1).
 * Rendered to static markup with react-dom/server — no DOM, no test library.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeadView } from "@/lib/api";
import type { DemoView } from "@/lib/demo";
import { DemoTabView, statusFromLead } from "./DemoTab";

function render(view: DemoView, extra: Partial<Parameters<typeof DemoTabView>[0]> = {}): string {
  return renderToStaticMarkup(
    <DemoTabView
      view={view}
      sub="allplumbing"
      subValid
      onSubChange={() => {}}
      busy={false}
      error={null}
      onBuild={() => {}}
      {...extra}
    />,
  );
}

describe("DemoTabView", () => {
  it("no demo yet: explanation + Build demo + the sub prefilled", () => {
    const html = render({ kind: "none" });
    expect(html).toContain("Build demo");
    expect(html).toContain("Builds a live demo site");
    expect(html).toContain('value="allplumbing"');
    expect(html).toContain(".demos.rapidforge.ai");
    expect(html).not.toContain("Rebuild");
    expect(html).not.toContain("Building…");
  });

  it("building: spinner, Building…, the log panel and a disabled button", () => {
    const html = render({ kind: "building", log: ["▸ Intake: all-plumbing-sewer", "▸ Build: 5 variants"] });
    expect(html).toContain("Building…");
    expect(html).toContain("animate-spin");
    expect(html).toContain("▸ Intake: all-plumbing-sewer");
    expect(html).toContain("▸ Build: 5 variants");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Build demo/);
    expect(html).toContain("Demo build log");
  });

  it("building with no lines yet shows a placeholder", () => {
    expect(render({ kind: "building", log: [] })).toContain("Starting the build…");
  });

  it("ready: big public link with Open/Copy, small preview link, built-at and Rebuild", () => {
    const html = render({
      kind: "ready",
      url: "https://allplumbing.demos.rapidforge.ai",
      previewUrl: "https://rapidforge-demos-abc123.vercel.app",
      builtAt: "2026-10-07T18:00:00.000Z",
      dnsPending: false,
    });
    expect(html).toContain('href="https://allplumbing.demos.rapidforge.ai"');
    expect(html).toContain("allplumbing.demos.rapidforge.ai");
    expect(html).toContain(">Open");
    expect(html).toContain(">Copy");
    expect(html).toContain('href="https://rapidforge-demos-abc123.vercel.app"');
    expect(html).toContain("preview (Vercel login)");
    expect(html).toContain("built ");
    expect(html).toContain("Rebuild");
    expect(html).not.toContain("public link goes live once DNS is set up");
  });

  it("ready with the alias pending shows the DNS note", () => {
    const html = render({
      kind: "ready",
      url: "https://allplumbing.demos.rapidforge.ai",
      previewUrl: null,
      builtAt: null,
      dnsPending: true,
    });
    expect(html).toContain("public link goes live once DNS is set up");
    expect(html).not.toContain("preview (Vercel login)");
  });

  it("failed: the error and Try again", () => {
    const html = render({ kind: "failed", error: "deploy: vercel deploy exited 1" });
    expect(html).toContain("deploy: vercel deploy exited 1");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Rebuild");
  });

  it("shows a request error (e.g. the 409) above any state without crashing", () => {
    const html = render({ kind: "none" }, { error: "A demo build is already running for this business" });
    expect(html).toContain("A demo build is already running for this business");
  });

  it("an invalid sub disables Build demo and explains the rule", () => {
    const html = render({ kind: "none" }, { sub: "All Plumbing!", subValid: false });
    expect(html).toContain("lowercase a-z, 0-9 and hyphens only");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Build demo/);
  });
});

describe("statusFromLead", () => {
  const lead = {
    result: { id: "r1" },
    audit: null,
    business: {
      id: "b1",
      name: "All Plumbing & Sewer",
      demo_status: "ready",
      demo_url: "https://allplumbing.demos.rapidforge.ai",
      demo_preview_url: "https://x.vercel.app",
      demo_sub: "allplumbing",
      demo_built_at: "2026-10-07T18:00:00.000Z",
      demo_error: null,
    },
  } as unknown as LeadView;

  it("seeds the tab from the business row's demo_* fields", () => {
    expect(statusFromLead(lead)).toEqual({
      demo_status: "ready",
      demo_url: "https://allplumbing.demos.rapidforge.ai",
      demo_preview_url: "https://x.vercel.app",
      demo_sub: "allplumbing",
      demo_built_at: "2026-10-07T18:00:00.000Z",
      demo_error: null,
      log: [],
      alias_ok: null,
    });
  });

  it("is null when the business has never been built", () => {
    const fresh = { ...lead, business: { ...lead.business, demo_status: null } } as LeadView;
    expect(statusFromLead(fresh)).toBeNull();
  });
});
