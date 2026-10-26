/**
 * Free-text category (RFL.SEARCH.CAT.2): a chip match submits its Places
 * type, any other phrase submits as typed, an empty box blocks; the chips
 * filter as the user types and clicking one fills the box. Rendered to
 * static markup with react-dom/server — no DOM.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KNOWN_PLACE_TYPES } from "@rapidforge/shared";
import {
  CATEGORIES,
  CategoryChips,
  categoryHint,
  categoryRequestValue,
  resolveCategory,
  SearchFilterControls,
  suggestedCategories,
} from "./SearchFilterControls";

function render(category: string): string {
  return renderToStaticMarkup(
    <SearchFilterControls
      category={category}
      onCategoryChange={() => {}}
      minReviews={0}
      onMinReviewsChange={() => {}}
      minRating={0}
      onMinRatingChange={() => {}}
      excludeChains
      onExcludeChainsChange={() => {}}
    />,
  );
}

describe("CATEGORIES", () => {
  it("trades lead, the core four first, groups in picker order", () => {
    expect(CATEGORIES.slice(0, 4).map((c) => c.type)).toEqual([
      "plumber",
      "electrician",
      "roofing_contractor",
      "general contractor",
    ]);
    const groups = [...new Set(CATEGORIES.map((c) => c.group))];
    expect(groups).toEqual(["Home services & trades", "Auto", "Health & wellness", "Other"]);
  });

  it("every chip is a Table A type routed to Nearby, bar the one phrase chip routed to Text Search, with no duplicates", () => {
    const types = CATEGORIES.map((c) => c.type);
    const phraseChips = CATEGORIES.filter((c) => !KNOWN_PLACE_TYPES.has(c.type));
    expect(phraseChips.map((c) => c.type)).toEqual(["general contractor"]);
    for (const c of phraseChips) expect(c.type).toBe(c.label.toLowerCase());
    expect(new Set(types).size).toBe(types.length);
    expect(types).not.toContain("hvac_contractor");
  });
});

describe("resolveCategory → request value + hint", () => {
  it("a chip's type or label (any case) is that Places type", () => {
    for (const text of ["plumber", "Plumber", " PLUMBER "]) {
      const r = resolveCategory(text);
      expect(r).toMatchObject({ kind: "type", category: { type: "plumber" } });
      expect(categoryRequestValue(r)).toBe("plumber");
      expect(categoryHint(r)).toBe("Category: Plumber");
    }
    expect(categoryRequestValue(resolveCategory("Roofer"))).toBe("roofing_contractor");
    expect(categoryRequestValue(resolveCategory("tire shop"))).toBe("tire_shop");
  });

  it("the General contractor chip submits its phrase (Text Search), also from the legacy type code", () => {
    for (const text of ["General contractor", "general contractor", "general_contractor"]) {
      expect(categoryRequestValue(resolveCategory(text))).toBe("general contractor");
    }
  });

  it("any other phrase submits as typed, trimmed and collapsed", () => {
    expect(resolveCategory("hvac")).toEqual({ kind: "phrase", phrase: "hvac" });
    expect(categoryRequestValue(resolveCategory("  HVAC  repair "))).toBe("HVAC repair");
    expect(categoryHint(resolveCategory("med spa"))).toBe("Searching Google for 'med spa'");
    // A prefix of a label is still a phrase — only an exact match is a type.
    expect(resolveCategory("plumb").kind).toBe("phrase");
    expect(categoryRequestValue(resolveCategory("x".repeat(100)))).toHaveLength(80);
  });

  it("an empty box has nothing to submit", () => {
    for (const text of ["", "   "]) {
      const r = resolveCategory(text);
      expect(r).toEqual({ kind: "empty" });
      expect(categoryRequestValue(r)).toBeNull();
      expect(categoryHint(r)).toBe("Type what kind of business to find");
    }
  });
});

describe("suggestedCategories", () => {
  it("all chips when empty, filtered by label or type as the user types, none for a phrase with no match", () => {
    expect(suggestedCategories("")).toEqual(CATEGORIES);
    expect(suggestedCategories("tire").map((c) => c.type)).toEqual(["tire_shop"]);
    expect(suggestedCategories("contractor").map((c) => c.type)).toEqual([
      "roofing_contractor",
      "general contractor",
    ]);
    expect(suggestedCategories("hvac")).toEqual([]);
  });
});

describe("SearchFilterControls", () => {
  it("renders the text box with the phrase as typed and the chips as shortcuts", () => {
    const html = render("");
    expect(html).toContain('placeholder="e.g. hvac, roofer, med spa"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain("Home services &amp; trades");
    expect(html).toMatch(/<button[^>]*>Chiropractor</);
  });

  it("a phrase with no chip match is valid: no chips, no block, Google is searched", () => {
    const html = render("hvac");
    expect(html).toContain('value="hvac"');
    expect(html).not.toMatch(/<button[^>]*>Plumber</);
    expect(html).toContain("No shortcut for ‘hvac’");
    expect(html).toContain("Google is searched");
    expect(html).not.toContain("Pick a category");
  });

  it("a chip match highlights the chip and shows its Places type", () => {
    const html = render("Tire shop");
    expect(html).toMatch(/data-testid="selected-type"[^>]*>tire_shop</);
    expect(html).toMatch(/<button[^>]*border-primary\/60[^>]*>Tire shop</);
    expect(html).toContain(">Auto<");
    expect(html).not.toContain("Home services &amp; trades");
  });

  it("clicking a chip fills the box with its label", () => {
    const onPick = vi.fn<(v: string) => void>();
    // CategoryChips is hook-free, so its element tree can be walked directly.
    type ChipProps = { onClick?: () => void; children?: ReactNode };
    const chips: ReactElement<ChipProps>[] = [];
    const visit = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!isValidElement<ChipProps>(n)) return;
      if (n.type === "button") chips.push(n);
      visit(n.props.children);
    };
    visit(CategoryChips({ suggestions: CATEGORIES, selectedType: null, onPick }));
    expect(chips).toHaveLength(CATEGORIES.length);
    const roofer = chips.find((c) => c.props.children === "Roofer");
    roofer!.props.onClick?.();
    expect(onPick).toHaveBeenCalledWith("Roofer");
  });
});
