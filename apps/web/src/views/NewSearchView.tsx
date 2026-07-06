/**
 * New Search (PRD 7.3) — Zip/Radius quick entry + Map tab (Sprint 5,
 * Joey's primary-mode spec). Keyword lands v1.5. Both tabs share the
 * category/min-reviews/rating/chains filters; each validates against the
 * shared schema before POSTing so worker and form can never disagree.
 */
import { Loader2, Search } from "lucide-react";
import { useState } from "react";
import { ZipRadiusParamsSchema } from "@rapidforge/shared";
import {
  CATEGORIES,
  SearchFilterControls,
} from "@/components/search/SearchFilterControls";
import { MapSearchTab } from "@/components/search/MapSearchTab";
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
import { estimatePlacesCalls } from "@/lib/geo";
import { getSearchDefaults } from "@/lib/search-defaults";
import { cn } from "@/lib/utils";

const RADIUS_PRESETS = [5, 10, 15, 25];

type SearchTab = "zip" | "map";

export interface NewSearchViewProps {
  onSearchCreated: (searchId: string) => void;
}

export function NewSearchView({ onSearchCreated }: NewSearchViewProps) {
  const [tab, setTab] = useState<SearchTab>("zip");
  const [zip, setZip] = useState("");
  // Settings → search defaults pre-fill radius + category (Sprint 5).
  const [radius, setRadius] = useState(
    () => getSearchDefaults()?.radius_miles ?? 10,
  );
  const [category, setCategory] = useState(() => {
    const preferred = getSearchDefaults()?.category_type;
    return CATEGORIES.find((c) => c.type === preferred) ?? CATEGORIES[0];
  });
  const [minReviews, setMinReviews] = useState(0);
  const [minRating, setMinRating] = useState(0);
  const [excludeChains, setExcludeChains] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const filterControls = (
    <SearchFilterControls
      category={category}
      onCategoryChange={setCategory}
      minReviews={minReviews}
      onMinReviewsChange={setMinReviews}
      minRating={minRating}
      onMinRatingChange={setMinRating}
      excludeChains={excludeChains}
      onExcludeChainsChange={setExcludeChains}
    />
  );

  return (
    <div
      className={cn(
        "mx-auto w-full space-y-4",
        tab === "map" ? "max-w-5xl" : "max-w-3xl",
      )}
    >
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
          Prospecting
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New Search</h1>
      </div>

      <div
        className="card-panel flex w-fit items-center gap-1 rounded-full p-1.5 text-xs"
        role="tablist"
        aria-label="Search mode"
      >
        <TabPill
          active={tab === "zip"}
          onClick={() => setTab("zip")}
          label="Zip / Radius"
        />
        <TabPill active={tab === "map"} onClick={() => setTab("map")} label="Map" />
        <span className="px-3 py-1 text-muted-foreground">
          Keyword <span className="font-mono text-[10px]">v1.5</span>
        </span>
      </div>

      {tab === "zip" ? (
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
                  className="w-full accent-[hsl(var(--primary))]"
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

            {filterControls}

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
      ) : (
        <div className="space-y-4">
          <MapSearchTab
            category={category}
            filters={{
              min_reviews: minReviews,
              min_rating: minRating,
              exclude_chains: excludeChains,
            }}
            onSearchCreated={onSearchCreated}
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filters</CardTitle>
              <CardDescription>
                Applied to the map search exactly like the zip tab.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">{filterControls}</CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function TabPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 transition-colors",
        active
          ? "bg-accent font-medium text-foreground shadow-card"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
