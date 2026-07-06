/**
 * Map-radius search (Sprint 5, Joey's primary-mode spec) — full-width map,
 * click to drop a pin, draggable/resizable radius circle (1–25 mi, native
 * editable-circle handles), live radius + estimated Places cost readout.
 * Uses the referrer-restricted VITE_GOOGLE_MAPS_BROWSER_KEY; when the key
 * is absent this renders a glass placeholder explaining the setup — never
 * a broken map. Run issues the same lat/lng+radius search the worker
 * already supports (mode 'map_draw').
 */
import { Loader2, MapPin, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createSearch } from "@/lib/api";
import { formatCents } from "@/lib/format";
import {
  clampRadiusMiles,
  estimatePlacesCalls,
  estimateSearchCostCents,
  mapSelectionToParams,
  milesToMeters,
  type LatLng,
  type SearchFilters,
} from "@/lib/geo";
import { radiusMilesToCircle, snapCircleRadius } from "@/lib/map-sync";
import {
  getMapsBrowserKey,
  loadGoogleMaps,
  onMapsAuthFailure,
} from "@/lib/maps-loader";
import { getSearchDefaults } from "@/lib/search-defaults";

/** Boise — Joey's market; the pin replaces this the moment the map is clicked. */
const DEFAULT_CENTER: LatLng = { lat: 43.615, lng: -116.2023 };
const DEFAULT_ZOOM = 11;

export interface MapSearchTabProps {
  category: { label: string; type: string } | undefined;
  filters: SearchFilters;
  onSearchCreated: (searchId: string) => void;
}

export function MapSearchTab({
  category,
  filters,
  onSearchCreated,
}: MapSearchTabProps) {
  const mapsKey = getMapsBrowserKey();
  if (!mapsKey) return <MapKeyPlaceholder />;
  return (
    <LiveMap
      mapsKey={mapsKey}
      category={category}
      filters={filters}
      onSearchCreated={onSearchCreated}
    />
  );
}

function LiveMap({
  mapsKey,
  category,
  filters,
  onSearchCreated,
}: MapSearchTabProps & { mapsKey: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const suppressRadiusEvent = useRef(false);

  const [pin, setPin] = useState<LatLng | null>(null);
  const [radiusMiles, setRadiusMiles] = useState(
    () => getSearchDefaults()?.radius_miles ?? 10,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Map bootstrap — once.
  useEffect(() => {
    let disposed = false;
    onMapsAuthFailure(() => {
      if (!disposed) {
        setLoadError(
          "Google rejected the browser key for this origin — add this URL to the key's HTTP-referrer allowlist (RefererNotAllowedMapError) and confirm Maps JavaScript API is enabled.",
        );
      }
    });
    void loadGoogleMaps(mapsKey)
      .then((maps) => {
        if (disposed || !containerRef.current) return;
        // Google's DEFAULT basemap in both themes (DESIGN_NOTES v3 §7) —
        // RapidForge styles only its own layers (pin, circle, chip).
        const map = new maps.Map(containerRef.current, {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          clickableIcons: false,
        });
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          const position = e.latLng;
          if (position) {
            setPin({ lat: position.lat(), lng: position.lng() });
          }
        });
        mapRef.current = map;
        setReady(true);
      })
      .catch((err) => {
        if (!disposed)
          setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      markerRef.current?.setMap(null);
      circleRef.current?.setMap(null);
      mapRef.current = null;
    };
  }, [mapsKey]);

  // Pin → marker + editable circle (created lazily on first drop).
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.google?.maps;
    if (!map || !maps || !pin) return;

    if (!markerRef.current) {
      const marker = new maps.Marker({
        map,
        position: pin,
        draggable: true,
        title: "Search center — drag to move",
      });
      // Circle follows the pin LIVE while dragging (S5.5 coupling).
      marker.addListener("drag", () => {
        const position = marker.getPosition();
        if (position) circleRef.current?.setCenter(position);
      });
      marker.addListener("dragend", () => {
        const position = marker.getPosition();
        if (position) setPin({ lat: position.lat(), lng: position.lng() });
      });
      markerRef.current = marker;
    } else {
      markerRef.current.setPosition(pin);
    }

    if (!circleRef.current) {
      const circle = new maps.Circle({
        map,
        center: pin,
        radius: milesToMeters(radiusMiles),
        editable: true, // native resize handle on the circle edge
        draggable: true,
        strokeColor: "#1a8fff",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: "#1a8fff",
        fillOpacity: 0.08,
      });
      // Edge handle resizes only — snapped to 0.1-mile steps in plan bounds.
      circle.addListener("radius_changed", () => {
        if (suppressRadiusEvent.current) return;
        const snap = snapCircleRadius(circle.getRadius());
        if (snap.needsResnap) {
          suppressRadiusEvent.current = true;
          circle.setRadius(snap.meters);
          suppressRadiusEvent.current = false;
        }
        setRadiusMiles(snap.miles);
      });
      // Dragging the circle BODY pans pin + circle together: the marker
      // tracks live via center_changed, state commits on dragend.
      circle.addListener("center_changed", () => {
        const center = circle.getCenter();
        if (center) markerRef.current?.setPosition(center);
      });
      circle.addListener("dragend", () => {
        const center = circle.getCenter();
        if (center) setPin({ lat: center.lat(), lng: center.lng() });
      });
      circleRef.current = circle;
      const bounds = circle.getBounds();
      if (bounds) map.fitBounds(bounds, 48);
    } else {
      circleRef.current.setCenter(pin);
    }
    // radiusMiles is synced by the effect below — only pin drives this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, ready]);

  // Slider/readout → circle radius (two-way sync, loop-guarded).
  useEffect(() => {
    const circle = circleRef.current;
    if (!circle) return;
    const target = radiusMilesToCircle(radiusMiles, circle.getRadius());
    if (target.needsUpdate) {
      suppressRadiusEvent.current = true;
      circle.setRadius(target.meters);
      suppressRadiusEvent.current = false;
    }
  }, [radiusMiles]);

  const estCalls = estimatePlacesCalls(radiusMiles);
  const estCost = formatCents(estimateSearchCostCents(radiusMiles));
  const canSubmit = pin !== null && !!category && !submitting;

  async function submit() {
    if (!pin || !category || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const params = mapSelectionToParams(pin, radiusMiles, filters);
      const { search_id } = await createSearch({
        mode: "map_draw",
        category: category.type,
        params,
      });
      onSearchCreated(search_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="card-panel space-y-2 p-6 text-sm">
        <p className="font-medium text-agent-error">Map failed to load</p>
        <p className="text-xs text-muted-foreground">{loadError}</p>
        <p className="text-xs text-muted-foreground">
          The Zip / Radius tab works without the map.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card-panel relative overflow-hidden p-0">
        <div
          ref={containerRef}
          className="h-[440px] w-full"
          role="application"
          aria-label="Map — click to drop a search pin"
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          </div>
        )}
        {/* Live readout chip */}
        <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-border bg-card/95 px-3.5 py-2 font-mono text-xs">
          {pin ? (
            <>
              <span className="text-primary">{radiusMiles} mi</span>
              <span className="text-muted-foreground">
                {" "}
                · ≈{estCalls} Places calls · ~{estCost}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              Click the map to drop a pin
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="map-radius" className="text-sm font-medium">
            Radius{" "}
            <span className="font-mono text-primary">{radiusMiles} mi</span>
          </label>
          <span className="font-mono text-[11px] text-muted-foreground">
            drag the circle handle or use the slider
          </span>
        </div>
        <input
          id="map-radius"
          type="range"
          min={1}
          max={25}
          step={0.5}
          value={radiusMiles}
          onChange={(e) => setRadiusMiles(clampRadiusMiles(Number(e.target.value)))}
          className="w-full accent-[hsl(var(--primary))]"
        />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <p className="font-mono text-[11px] text-muted-foreground">
          {pin
            ? `pin ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)} · est. ≈${estCalls} calls (~${estCost} + details)`
            : "no pin yet"}
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
    </div>
  );
}

/** Graceful key-absent state (kickoff: never a broken map). */
function MapKeyPlaceholder() {
  return (
    <div className="card-panel flex flex-col items-center gap-3 px-8 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/40 bg-primary/10">
        <MapPin className="h-6 w-6 text-primary" aria-hidden />
      </span>
      <h3 className="text-base font-semibold">Map search needs a browser key</h3>
      <div className="max-w-md space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Create a <span className="font-mono">Maps JavaScript API</span> key in
          Google Cloud (the same project as the Places key), restrict it by
          HTTP referrer, and add it to{" "}
          <span className="font-mono">apps/web/.env</span>:
        </p>
        <p className="rounded-xl border border-border bg-accent/30 px-3 py-2 font-mono text-[11px]">
          VITE_GOOGLE_MAPS_BROWSER_KEY=your-browser-key
        </p>
        <p>
          Restart <span className="font-mono">npm run dev</span> and this tab
          becomes a live map. Map loads are free-tier; searches still run
          through the worker. The Zip / Radius tab works today without it.
        </p>
      </div>
    </div>
  );
}
