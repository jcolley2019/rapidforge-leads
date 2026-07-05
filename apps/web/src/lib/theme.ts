/**
 * Theme preference (DESIGN_NOTES.md): dark default, light toggle, persisted.
 * index.html applies the stored theme before first paint; this module owns
 * runtime toggling.
 */
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "rapidforge-theme";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // private mode etc. — theme just won't persist
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
