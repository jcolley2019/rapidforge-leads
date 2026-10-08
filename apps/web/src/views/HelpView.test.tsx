/**
 * HelpView (RFL.HELP.4) — every section heading, the in-page nav and the
 * glossary render, and each "Go to" button sends onGoTo the right view.
 * HelpView is hook-free, so the tree walk expands its function components
 * and presses the buttons without a DOM.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { HelpView } from "./HelpView";
import { RAIL_GROUPS, VIEWS, type ViewKey } from "./views";

const HEADINGS = [
  "Run a search",
  "Read a score",
  "Open the lead drawer",
  "Export",
  "Build a demo",
  "Settings",
];

type Props = Record<string, unknown>;

/** Plain text of an element's children (icons and other elements skipped). */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<Props>(node)) return textOf(node.props.children as ReactNode);
  return "";
}

/** Every <Button> in the tree, expanding plain function components. */
function buttons(node: ReactNode): ReactElement<Props>[] {
  const found: ReactElement<Props>[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isValidElement<Props>(n)) return;
    if (n.type === Button) found.push(n);
    if (typeof n.type === "function") {
      visit((n.type as (p: Props) => ReactNode)(n.props));
    } else {
      visit(n.props.children as ReactNode);
    }
  };
  visit(node);
  return found;
}

describe("HelpView", () => {
  const html = renderToStaticMarkup(<HelpView onGoTo={() => {}} />);

  it("renders the page header, all six section headings and the Glossary", () => {
    expect(html).toContain(">Help</h1>");
    for (const heading of [...HEADINGS, "Glossary"]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(html).toContain("Hot lead");
    expect(html).toContain("Cascading variables");
  });

  it("the in-page nav links to every section", () => {
    expect(html).toContain('aria-label="Help sections"');
    const anchors = [...html.matchAll(/href="#(help-[a-z]+)"/g)].map((m) => m[1]);
    expect(anchors).toHaveLength(7);
    for (const id of anchors) expect(html).toContain(`id="${id}"`);
  });

  it("each Go to button calls onGoTo with its view's key", () => {
    const onGoTo = vi.fn<(view: ViewKey) => void>();
    const goTo = buttons(<HelpView onGoTo={onGoTo} />).filter((b) =>
      textOf(b.props.children as ReactNode).startsWith("Go to "),
    );
    expect(goTo.map((b) => textOf(b.props.children as ReactNode))).toEqual([
      "Go to New Search",
      "Go to Leads",
      "Go to Leads",
      "Go to Leads",
      "Go to Pipeline",
      "Go to Settings",
    ]);
    for (const b of goTo) (b.props.onClick as () => void)();
    expect(onGoTo.mock.calls.map(([key]) => key)).toEqual([
      "new-search",
      "leads",
      "leads",
      "leads",
      "pipeline",
      "settings",
    ]);
  });

  it("Help is a view, listed under Account after Settings", () => {
    expect(VIEWS.some((v) => v.key === "help" && v.label === "Help")).toBe(true);
    expect(RAIL_GROUPS.find((g) => g.header === "Account")?.keys).toEqual([
      "settings",
      "help",
    ]);
  });
});
