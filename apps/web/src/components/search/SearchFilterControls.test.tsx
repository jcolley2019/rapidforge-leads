/**
 * Category picker (RFL.SEARCH.CAT.1): filter text that matches nothing
 * keeps the selection and blocks submit; the selected label is always
 * visible. Rendered to static markup with react-dom/server — no DOM.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  categoryQueryMismatch,
  SearchFilterControls,
} from "./SearchFilterControls";

const plumber = CATEGORIES.find((c) => c.type === "plumber")!;

function render(categoryQuery: string, category = plumber): string {
  return renderToStaticMarkup(
    <SearchFilterControls
      category={category}
      onCategoryChange={() => {}}
      categoryQuery={categoryQuery}
      onCategoryQueryChange={() => {}}
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
      "general_contractor",
    ]);
    const groups = [...new Set(CATEGORIES.map((c) => c.group))];
    expect(groups).toEqual(["Home services & trades", "Auto", "Health & wellness", "Other"]);
  });

  it("carries the three Table A additions and no duplicate types", () => {
    const types = CATEGORIES.map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(["chiropractor", "skin_care_clinic", "tire_shop"]));
    expect(new Set(types).size).toBe(types.length);
    // Not a Places (New) Table A type — must never be sent as includedTypes.
    expect(types).not.toContain("hvac_contractor");
  });
});

describe("categoryQueryMismatch", () => {
  it("empty or matching text never blocks", () => {
    expect(categoryQueryMismatch("", plumber)).toBe(false);
    expect(categoryQueryMismatch("   ", plumber)).toBe(false);
    expect(categoryQueryMismatch("plumb", plumber)).toBe(false);
    expect(categoryQueryMismatch("PLUMBER", plumber)).toBe(false);
  });

  it("text that names no chip, or a chip other than the selected one, blocks", () => {
    expect(categoryQueryMismatch("hvac", plumber)).toBe(true);
    expect(categoryQueryMismatch("tire", plumber)).toBe(true);
    expect(categoryQueryMismatch("tire", undefined)).toBe(true);
  });
});

describe("SearchFilterControls", () => {
  it("always shows the selected label and its Places type", () => {
    const html = render("");
    expect(html).toMatch(/data-testid="selected-category"[^>]*>Plumber</);
    expect(html).toContain(">plumber<");
    expect(html).toContain("Home services &amp; trades");
    expect(html).toContain(">Chiropractor<");
  });

  it("no match: names the text, keeps the selection, renders no chips", () => {
    const html = render("hvac");
    expect(html).toContain("No category matches ‘hvac’");
    expect(html).toContain("clear the box to keep Plumber");
    expect(html).toMatch(/data-testid="selected-category"[^>]*>Plumber</);
    expect(html).not.toMatch(/<button[^>]*>Plumber</);
    expect(html).not.toContain("Home services &amp; trades");
  });

  it("filters to the matching chip and only its group heading", () => {
    const html = render("tire");
    expect(html).toMatch(/<button[^>]*>Tire shop</);
    expect(html).toContain(">Auto<");
    expect(html).not.toContain("Home services &amp; trades");
    expect(html).not.toMatch(/<button[^>]*>Plumber</);
  });
});
