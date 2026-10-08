/**
 * First-run coaching tips (RFL.HELP.4): which tips a user has dismissed.
 * A UI convenience, so localStorage is the right home (as with theme.ts and
 * search-defaults.ts). Keyed per user so two logins on one browser keep
 * their own tips. Every read and write is guarded: private mode, a full
 * quota or corrupt JSON all just mean "nothing dismissed".
 */
export const TIP_IDS = [
  "dashboard",
  "new-search",
  "workspace",
  "leads",
  "pipeline",
  "drawer",
] as const;

export type TipId = (typeof TIP_IDS)[number];

export function coachingKey(userId: string): string {
  return `rapidforge-coaching:${userId}`;
}

/** Stored value: a JSON array of dismissed tip ids. */
function readDismissed(userId: string): string[] {
  try {
    const raw = localStorage.getItem(coachingKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function isDismissed(userId: string, tipId: TipId): boolean {
  return readDismissed(userId).includes(tipId);
}

export function dismiss(userId: string, tipId: TipId): void {
  const dismissed = readDismissed(userId);
  if (dismissed.includes(tipId)) return;
  try {
    localStorage.setItem(
      coachingKey(userId),
      JSON.stringify([...dismissed, tipId]),
    );
  } catch {
    // storage unavailable — the tip just comes back next visit
  }
}

export function resetAll(userId: string): void {
  try {
    localStorage.removeItem(coachingKey(userId));
  } catch {
    // storage unavailable — nothing was persisted to clear
  }
}
