/**
 * New Search — zip/radius mode (PRD 7.3). Map Draw and Keyword tabs land
 * v1.5. Validates against the shared ZipRadiusParamsSchema before POSTing
 * so the worker and form can never disagree.
 */
import { Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ZipRadiusParamsSchema } from "@rapidforge/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSearch } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Curated Places (New) included types (PRD 6.1 type filter). */
const CATEGORIES: Array<{ label: string; type: string }> = [
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

const RADIUS_PRESETS = [5, 10, 15, 25];

const RATING_PRESETS = [
  { label: "Any", value: 0 },
  { label: "3.0+", value: 3 },
  { label: "3.5+", value: 3.5 },
  { label: "4.0+", value: 4 },
  { label: "4.5+", value: 4.5 },
];

/** Rough Nearby-call count for the cost hint (mirrors worker tile bands). */
function estimatePlacesCalls(radiusMiles: number): number {
  if (radiusMiles <= 3.1) return 1;
  if (radiusMiles <= 9.3) return 9;
  return 30;
}

export interface NewSearchViewProps {
  onSearchCreated: (searchId: string) => void;
}

export function NewSearchView({ onSearchCreated }: NewSearchViewProps) {
  const [zip, setZip] = useState("");
  const [radius, setRadius] = useState(10);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [minReviews, setMinReviews] = useState(0);
  const [minRating, setMinRating] = useState(0);
  const [excludeChains, setExcludeChains] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredCategories = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES.filter((c) => c.label.toLowerCase().includes(q));
  }, [categoryQuery]);

  const params = {
    zip,
    radius_miles: radius,
    min_reviews: minReviews,
    min_rating: minRating,
    exclude_chains: excludeChains,
  };
  const validation = ZipRadiusParamsSchema.safeParse(params);
  const canSubmit = validation.success && !!category && !submitting;

  async function submit() {
    if (!canSubmit || !category) return;
    setSubmitting(true);
    setError(null);
    try {
      const { search_id } = await createSearch({
        mode: "zip_radius",
        category: category.type,
        params,
      });
      onSearchCreated(search_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const estCalls = estimatePlacesCalls(radius);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
          Prospecting
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New Search</h1>
      </div>

      <div className="glass-card flex w-fit items-center gap-1 rounded-full p-1.5 text-xs">
        <span className="rounded-full bg-accent px-3 py-1 font-medium text-foreground shadow-card">
          Zip / Radius
        </span>
        <span className="px-3 py-1 text-muted-foreground">
          Map Draw <span className="font-mono text-[10px]">v1.5</span>
        </span>
        <span className="px-3 py-1 text-muted-foreground">
          Keyword <span className="font-mono text-[10px]">v1.5</span>
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search area</CardTitle>
          <CardDescription>
            Center on a zip code and sweep outward. Large radii are
            grid-tiled into multiple Places calls automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="zip">Zip code</Label>
              <Input
                id="zip"
                inputMode="numeric"
                maxLength={5}
                placeholder="83686"
                value={zip}
                onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="radius">
                Radius{" "}
                <span className="font-mono text-primary">{radius} mi</span>
              </Label>
              <input
                id="radius"
                type="range"
                min={1}
                max={25}
                step={1}
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="w-full accent-[#00d9ff]"
              />
              <div className="flex gap-1.5">
                {RADIUS_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRadius(preset)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
                      radius === preset
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {preset} mi
                  </button>
                ))}
              </div>
            </div>
          </div>

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
                  onClick={() => setCategory(c)}
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
                  No matching category — the curated list maps to Google
                  Places types.
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
                  setMinReviews(Math.max(0, Number(e.target.value) || 0))
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
                    onClick={() => setMinRating(preset.value)}
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
                  onChange={(e) => setExcludeChains(e.target.checked)}
                  className="accent-[#00d9ff]"
                />
                Exclude chains
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <p className="font-mono text-[11px] text-muted-foreground">
              est. ≈{estCalls} Places calls (~${(estCalls * 0.032).toFixed(2)}{" "}
              + details) · free in fixture mode
            </p>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Search className="mr-2 h-4 w-4" aria-hidden />
              )}
              Run search
            </Button>
          </div>

          {error && (
            <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
