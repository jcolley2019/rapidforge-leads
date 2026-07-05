/**
 * Google Maps JS API loader (Sprint 5 map tab). Hand-rolled singleton —
 * no loader dependency. The browser key is referrer-restricted and
 * browser-safe by design (PRD Section 9); it is the ONLY key that may
 * carry the VITE_ prefix besides Supabase's anon values.
 */
const SCRIPT_ID = "rapidforge-google-maps";
const CALLBACK = "__rapidforgeMapsReady";

declare global {
  interface Window {
    [CALLBACK]?: () => void;
    google?: typeof google;
  }
}

/** Trimmed key or null — null renders the graceful placeholder tab. */
export function getMapsBrowserKey(): string | null {
  const raw = (import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "") as string;
  const key = raw.trim();
  return key.length > 0 ? key : null;
}

let mapsPromise: Promise<typeof google.maps> | null = null;

export function loadGoogleMaps(key: string): Promise<typeof google.maps> {
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }
    window[CALLBACK] = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("Google Maps loaded without maps namespace"));
      delete window[CALLBACK];
    };
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${CALLBACK}`;
    script.onerror = () => {
      mapsPromise = null;
      script.remove();
      reject(
        new Error(
          "Google Maps failed to load — check the key's referrer restrictions and that Maps JavaScript API is enabled",
        ),
      );
    };
    document.head.appendChild(script);
  });
  return mapsPromise;
}
