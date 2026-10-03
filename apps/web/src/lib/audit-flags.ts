/**
 * Audit display flags (RFL-03 / audit finding 4). Pure so the chips stay
 * consistent across the results table, lead list and drawer.
 */
import type { Audit } from "@rapidforge/shared";

/** Audit was attempted and gave up (e.g. stale-reclaimed, RFL-02). */
export function isFailedAudit(audit: Pick<Audit, "status"> | null | undefined): boolean {
  return audit?.status === "failed";
}

/** Hover text for the "Could not audit" chip. */
export function failedAuditReason(
  audit: Pick<Audit, "error_message"> | null | undefined,
): string {
  const message = audit?.error_message?.trim();
  return message ? message : "The audit did not complete";
}

/**
 * Scores are placeholders, not measurements (bot protection blocked the
 * audit — audits.provisional, migration 0007a). Absent column = false.
 */
export function isProvisionalAudit(
  audit: Pick<Audit, "provisional"> | null | undefined,
): boolean {
  return audit?.provisional === true;
}
