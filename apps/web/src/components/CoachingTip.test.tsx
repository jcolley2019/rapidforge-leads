/**
 * CoachingTip (RFL.HELP.4) — rendered with react-dom/server; the X and
 * "Learn more" buttons are pressed by calling the onClick found in the
 * hook-free CoachingTipCard's element tree (no DOM in the web tests).
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismiss, isDismissed } from "@/lib/coaching";
import {
  CoachingContext,
  CoachingTip,
  CoachingTipCard,
  type CoachingContextValue,
} from "./CoachingTip";

type Props = Record<string, unknown>;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

/** Elements in a hook-free element tree whose props match. */
function findAll(
  node: ReactNode,
  match: (props: Props) => boolean,
): ReactElement<Props>[] {
  const found: ReactElement<Props>[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isValidElement<Props>(n)) return;
    if (match(n.props)) found.push(n);
    visit(n.props.children as ReactNode);
  };
  visit(node);
  return found;
}

/** The single element whose props match; fails the test otherwise. */
function only(node: ReactNode, match: (props: Props) => boolean): ReactElement<Props> {
  const found = findAll(node, match);
  expect(found).toHaveLength(1);
  return found[0] as ReactElement<Props>;
}

function renderTip(context?: CoachingContextValue): string {
  const tip = (
    <CoachingTip tipId="dashboard" title="Start with a search">
      Press New search to begin.
    </CoachingTip>
  );
  return renderToStaticMarkup(
    context ? (
      <CoachingContext.Provider value={context}>{tip}</CoachingContext.Provider>
    ) : (
      tip
    ),
  );
}

function card(onDismissed = vi.fn(), onOpenHelp: (() => void) | null = null) {
  return CoachingTipCard({
    userId: "preview",
    tipId: "dashboard",
    title: "Start with a search",
    children: "Press New search to begin.",
    onOpenHelp,
    onDismissed,
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoachingTip", () => {
  it("renders a note with the title, body and a dismiss button", () => {
    const html = renderTip();
    expect(html).toContain('role="note"');
    expect(html).toContain("Start with a search");
    expect(html).toContain("Press New search to begin.");
    expect(html).toContain('aria-label="Dismiss tip"');
    // No open-Help action in context → no "Learn more".
    expect(html).not.toContain("Learn more");
  });

  it("offers Learn more when the context can open Help, and it opens Help", () => {
    expect(renderTip({ userId: "u1", openHelp: () => {} })).toContain(
      "Learn more →",
    );
    const openHelp = vi.fn();
    const learnMore = only(card(vi.fn(), openHelp), (p) => p.onClick === openHelp);
    (learnMore.props.onClick as () => void)();
    expect(openHelp).toHaveBeenCalledOnce();
  });

  it("X dismisses: the dismissal persists and the tip is gone on re-render", () => {
    expect(renderTip()).toContain("Start with a search");
    const onDismissed = vi.fn();
    const x = only(card(onDismissed), (p) => p["aria-label"] === "Dismiss tip");
    (x.props.onClick as () => void)();
    expect(onDismissed).toHaveBeenCalledOnce();
    expect(isDismissed("preview", "dashboard")).toBe(true);
    expect(renderTip()).toBe("");
  });

  it("a dismissed tip does not render, for that user only", () => {
    dismiss("user-a", "dashboard");
    expect(renderTip({ userId: "user-a", openHelp: null })).toBe("");
    expect(renderTip({ userId: "user-b", openHelp: null })).toContain(
      "Start with a search",
    );
  });
});
