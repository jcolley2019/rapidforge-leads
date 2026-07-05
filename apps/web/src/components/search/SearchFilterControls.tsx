/**
 * Shared search filters (PRD 7.3) — category picker + min reviews / min
 * rating / chains. One component so the Zip and Map tabs can never drift
 * (Sprint 5 kickoff: the map respects the same filters).
 */
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Curated Places (New) included types (PRD 6.1 type filter). */
export const CATEGORIES: Array<{ label: string; type: string }> = [
  { label: "Plumber", type: "plumber" },
  { label: "Electrician", type: "electrician" },
  { label: "Roofer", type: "roofing_contractor" },
  { label: "General contractor", type: "general_contractor" },
  { label: "Painter", type: "painter" },
  { label: "Locksmith", type: "locksmith" },
  { label: "Moving company", type: "moving_company" },
  { label: "Dentist", type: "dentist" },
  { label: "Hair salon", type: "hair_salon" },
  { label: "Beauty salon", type: "beauty_salon" },
  { label: "Spa", type: "spa" },
  { label: "Gym", type: "gym" },
  { label: "Restaurant", type: "restaurant" },
  { label: "Cafe", type: "cafe" },
  { label: "Auto repair", type: "car_repair" },
  { label: "Car wash", type: "car_wash" },
  { label: "Real estate agency", type: "real_estate_agency" },
  { label: "Lawyer", type: "lawyer" },
  { label: "Veterinarian", type: "veterinary_care" },
  { label: "Florist", type: "florist" },
];

const RATING_PRESETS = [
  { label: "Any", value: 0 },
  { label: "3.0+", value: 3 },
  { label: "3.5+", value: 3.5 },
  { label: "4.0+", value: 4 },
  { label: "4.5+", value: 4.5 },
];

export interface SearchFilterControlsProps {
  category: { label: string; type: string } | undefined;
  onCategoryChange: (category: { label: string; type: string }) => void;
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
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pt-1">
          {filteredCategories.map((c) => (
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
              className="accent-[#00d9ff]"
            />
            Exclude chains
          </label>
        </div>
      </div>
    </>
  );
}
