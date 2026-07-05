/**
 * Default search parameters (Settings → New Search). Purely a UI
 * convenience, so localStorage is the right home — workspace_config stays
 * reserved for the cascading agent variables (PRD 5.1).
 */
const KEY = "rapidforge-search-defaults";

export interface SearchDefaults {
  radius_miles: number;
  category_type: string;
}

export function getSearchDefaults(): SearchDefaults | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SearchDefaults>;
    if (
      typeof parsed.radius_miles !== "number" ||
      parsed.radius_miles < 1 ||
      parsed.radius_miles > 25 ||
      typeof parsed.category_type !== "string"
    ) {
      return null;
    }
    return {
      radius_miles: parsed.radius_miles,
      category_type: parsed.category_type,
    };
  } catch {
    return null;
  }
}

export function saveSearchDefaults(defaults: SearchDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(defaults));
  } catch {
    // storage unavailable (private mode) — defaults just don't persist
  }
}
