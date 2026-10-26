/**
 * Shared search filters (PRD 7.3) — what-kind-of-business text + min
 * reviews / min rating / chains. One component so the Zip and Map tabs can
 * never drift (Sprint 5 kickoff: the map respects the same filters).
 *
 * RFL.SEARCH.CAT.2: the category is free text. A phrase that matches one of
 * the CATEGORIES (by label or type) submits that Places type and runs
 * Nearby Search on the worker; any other phrase submits as typed and runs
 * Text Search. The chips beneath the box are shortcuts that fill it.
 */
import { useMemo } from "react";
import { CATEGORY_MAX_CHARS } from "@rapidforge/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type CategoryGroup =
  | "Home services & trades"
  | "Auto"
  | "Health & wellness"
  | "Other";

export interface Category {
  label: string;
  /**
   * The `category` request value: a Table A type code (Nearby Search), or —
   * for a phrase chip such as "general contractor", which is Table B and not
   * valid for includedTypes — the phrase itself (Text Search).
   */
  type: string;
  group: CategoryGroup;
}

/**
 * Curated Places (New) included types (PRD 6.1 type filter). The worker
 * passes `type` straight to Nearby Search `includedTypes`, so every entry
 * must be spelled exactly as Google's place-types Table A lists it
 * (RFL.SEARCH.CAT.1) and be in the shared KNOWN_PLACE_TYPES set. There is
 * no HVAC, landscaping, pest-control or handyman type in Table A — those
 * trades are typed as a phrase and found through Text Search instead, as is
 * "general contractor" (Table B; RFL.SEARCH.CAT.2.1), kept as a phrase chip.
 * Trades first (the core four, then alphabetical), then the other groups.
 */
export const CATEGORIES: Category[] = [
  { label: "Plumber", type: "plumber", group: "Home services & trades" },
  { label: "Electrician", type: "electrician", group: "Home services & trades" },
  { label: "Roofer", type: "roofing_contractor", group: "Home services & trades" },
  { label: "General contractor", type: "general contractor", group: "Home services & trades" },
  { label: "Locksmith", type: "locksmith", group: "Home services & trades" },
  { label: "Moving company", type: "moving_company", group: "Home services & trades" },
  { label: "Painter", type: "painter", group: "Home services & trades" },
  { label: "Auto repair", type: "car_repair", group: "Auto" },
  { label: "Car wash", type: "car_wash", group: "Auto" },
  { label: "Tire shop", type: "tire_shop", group: "Auto" },
  { label: "Chiropractor", type: "chiropractor", group: "Health & wellness" },
  { label: "Dentist", type: "dentist", group: "Health & wellness" },
  { label: "Gym", type: "gym", group: "Health & wellness" },
  { label: "Skin care clinic", type: "skin_care_clinic", group: "Health & wellness" },
  { label: "Spa", type: "spa", group: "Health & wellness" },
  { label: "Beauty salon", type: "beauty_salon", group: "Other" },
  { label: "Cafe", type: "cafe", group: "Other" },
  { label: "Florist", type: "florist", group: "Other" },
  { label: "Hair salon", type: "hair_salon", group: "Other" },
  { label: "Lawyer", type: "lawyer", group: "Other" },
  { label: "Real estate agency", type: "real_estate_agency", group: "Other" },
  { label: "Restaurant", type: "restaurant", group: "Other" },
  { label: "Veterinarian", type: "veterinary_care", group: "Other" },
];

const CATEGORY_GROUPS: CategoryGroup[] = [
  "Home services & trades",
  "Auto",
  "Health & wellness",
  "Other",
];

const RATING_PRESETS = [
  { label: "Any", value: 0 },
  { label: "3.0+", value: 3 },
  { label: "3.5+", value: 3.5 },
  { label: "4.0+", value: 4 },
  { label: "4.5+", value: 4.5 },
];

/** What the box holds, as the worker will see it. */
export type ResolvedCategory =
  | { kind: "empty" }
  | { kind: "type"; category: Category }
  | { kind: "phrase"; phrase: string };

/** Trim and collapse whitespace — the same normalisation the worker applies. */
export function normalizeCategoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * A box matching a chip's label or type (case-insensitive) is that chip's
 * request value; anything else is a free phrase, submitted as typed. The
 * legacy "general_contractor" (a saved default) maps to its phrase chip.
 */
export function resolveCategory(text: string): ResolvedCategory {
  const phrase = normalizeCategoryText(text).slice(0, CATEGORY_MAX_CHARS);
  if (!phrase) return { kind: "empty" };
  const q = phrase.toLowerCase();
  const category = CATEGORIES.find(
    (c) =>
      c.type === q || c.label.toLowerCase() === q || c.type === q.replace(/_/g, " "),
  );
  return category ? { kind: "type", category } : { kind: "phrase", phrase };
}

/** The `category` value for POST /api/searches; null when nothing to submit. */
export function categoryRequestValue(resolved: ResolvedCategory): string | null {
  switch (resolved.kind) {
    case "empty":
      return null;
    case "type":
      return resolved.category.type;
    case "phrase":
      return resolved.phrase;
  }
}

/** Submit-row hint naming the path the worker will take. */
export function categoryHint(resolved: ResolvedCategory): string {
  switch (resolved.kind) {
    case "empty":
      return "Type what kind of business to find";
    case "type":
      return `Category: ${resolved.category.label}`;
    case "phrase":
      return `Searching Google for '${resolved.phrase}'`;
  }
}

/** Chips whose label or type contains the box text (all when empty). */
export function suggestedCategories(text: string): Category[] {
  const q = normalizeCategoryText(text).toLowerCase();
  if (!q) return CATEGORIES;
  return CATEGORIES.filter(
    (c) => c.label.toLowerCase().includes(q) || c.type.includes(q),
  );
}

/** Shortcut chips, grouped; clicking one fills the box with its label. Hook-free for tests. */
export function CategoryChips({
  suggestions,
  selectedType,
  onPick,
}: {
  suggestions: Category[];
  selectedType: string | null;
  onPick: (label: string) => void;
}) {
  return (
    <>
      {CATEGORY_GROUPS.map((group) => {
        const members = suggestions.filter((c) => c.group === group);
        if (members.length === 0) return null;
        return (
          <div key={group} className="space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {group}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {members.map((c) => (
                <button
                  key={c.type}
                  type="button"
                  onClick={() => onPick(c.label)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    selectedType === c.type
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

export interface SearchFilterControlsProps {
  /** The box text, owned by the view (the request is derived with resolveCategory). */
  category: string;
  onCategoryChange: (value: string) => void;
  minReviews: number;
  onMinReviewsChange: (value: number) => void;
  minRating: number;
  onMinRatingChange: (value: number) => void;
  excludeChains: boolean;
  onExcludeChainsChange: (value: boolean) => void;
}

export function SearchFilterControls({
  category,
  onCategoryChange,
  minReviews,
  onMinReviewsChange,
  minRating,
  onMinRatingChange,
  excludeChains,
  onExcludeChainsChange,
}: SearchFilterControlsProps) {
  const resolved = useMemo(() => resolveCategory(category), [category]);
  const suggestions = useMemo(() => suggestedCategories(category), [category]);
  const selectedType = resolved.kind === "type" ? resolved.category.type : null;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="category">
          What kind of business?{" "}
          {resolved.kind === "type" && (
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="selected-type">
              {resolved.category.type}
            </span>
          )}
        </Label>
        <Input
          id="category"
          placeholder="e.g. hvac, roofer, med spa"
          value={category}
          maxLength={CATEGORY_MAX_CHARS}
          onChange={(e) => onCategoryChange(e.target.value)}
        />
        <div className="max-h-40 space-y-2 overflow-y-auto pt-1">
          <CategoryChips
            suggestions={suggestions}
            selectedType={selectedType}
            onPick={onCategoryChange}
          />
          {suggestions.length === 0 && resolved.kind === "phrase" && (
            <span className="text-xs text-muted-foreground">
              No shortcut for &lsquo;{resolved.phrase}&rsquo; — Google is searched
              for the phrase as typed.
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="min-reviews">Min reviews</Label>
          <Input
            id="min-reviews"
            type="number"
            min={0}
            value={minReviews}
            onChange={(e) =>
              onMinReviewsChange(Math.max(0, Number(e.target.value) || 0))
            }
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label>Min rating</Label>
          <div className="flex flex-wrap gap-1.5">
            {RATING_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => onMinRatingChange(preset.value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                  minRating === preset.value
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="exclude-chains">Chains</Label>
          <label
            htmlFor="exclude-chains"
            className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-border px-3.5 text-sm text-muted-foreground"
          >
            <input
              id="exclude-chains"
              type="checkbox"
              checked={excludeChains}
              onChange={(e) => onExcludeChainsChange(e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            Exclude chains
          </label>
        </div>
      </div>
    </>
  );
}
