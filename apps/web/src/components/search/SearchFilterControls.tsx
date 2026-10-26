/**
 * Shared search filters (PRD 7.3) — category picker + min reviews / min
 * rating / chains. One component so the Zip and Map tabs can never drift
 * (Sprint 5 kickoff: the map respects the same filters).
 */
import { useMemo, useState } from "react";
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
  type: string;
  group: CategoryGroup;
}

/**
 * Curated Places (New) included types (PRD 6.1 type filter). The worker
 * passes `type` straight to Nearby Search `includedTypes`, so every entry
 * must be spelled exactly as Google's place-types Table A lists it
 * (RFL.SEARCH.CAT.1). There is no HVAC, landscaping, pest-control or
 * handyman type in Table A — those trades cannot be searched by type.
 * Trades first (the core four, then alphabetical), then the other groups.
 */
export const CATEGORIES: Category[] = [
  { label: "Plumber", type: "plumber", group: "Home services & trades" },
  { label: "Electrician", type: "electrician", group: "Home services & trades" },
  { label: "Roofer", type: "roofing_contractor", group: "Home services & trades" },
  { label: "General contractor", type: "general_contractor", group: "Home services & trades" },
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

export interface SearchFilterControlsProps {
  category: Category | undefined;
  onCategoryChange: (category: Category) => void;
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
  const [categoryQuery, setCategoryQuery] = useState("");

  const filteredCategories = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES.filter((c) => c.label.toLowerCase().includes(q));
  }, [categoryQuery]);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="category">
          Category{" "}
          {category && (
            <span className="font-mono text-[11px] text-primary">
              {category.type}
            </span>
          )}
        </Label>
        <Input
          id="category"
          placeholder="Filter categories…"
          value={categoryQuery}
          onChange={(e) => setCategoryQuery(e.target.value)}
        />
        <div className="max-h-40 space-y-2 overflow-y-auto pt-1">
          {CATEGORY_GROUPS.map((group) => {
            const members = filteredCategories.filter((c) => c.group === group);
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
                      onClick={() => onCategoryChange(c)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs transition-colors",
                        category?.type === c.type
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
          {filteredCategories.length === 0 && (
            <span className="text-xs text-muted-foreground">
              No matching category — the curated list maps to Google Places
              types.
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
