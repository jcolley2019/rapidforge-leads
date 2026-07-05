/** Small display formatters shared across views (Sprint 5). */

/** "3h ago" / "in 2d" / "just now" — null passes through for missing data. */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return null;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const span =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m`
        : hours < 24
          ? `${hours}h`
          : `${days}d`;
  if (span === "just now") return span;
  return future ? `in ${span}` : `${span} ago`;
}

/** Cents → "$1.23" (usage meter, cost hints). */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
