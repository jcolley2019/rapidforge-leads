/**
 * Which audit a lead row shows (RFL.WEB.10). Pure, shared by both stores.
 *
 * search_results.latest_audit_id is a write-time pointer: Filter points it
 * at the audit row it inserts, which may be 'pending' and may later fail or
 * be abandoned. A row read through that pointer could therefore hide a
 * perfectly good completed audit behind a newer failed one (Accurbore,
 * 2026-10-05). Reads resolve the display audit from the audits table
 * instead: the newest completed one; only when the business has never
 * completed an audit, the newest of any status — so the RFL-03 failed /
 * pending / provisional chips still render.
 */
import type { Audit } from "@rapidforge/shared";

/** Completion first, creation as the tiebreak, for ordering completed rows. */
function completionStamp(audit: Audit): string {
  return audit.completed_at ?? audit.created_at ?? "";
}

/**
 * `candidates` in insertion order (oldest first): on a timestamp tie the
 * later row wins, which is the newer audit when stamps share a millisecond
 * (MemoryStore; Postgres stamps are microsecond-resolved).
 */
export function pickDisplayAudit(candidates: readonly Audit[]): Audit | null {
  let completed: Audit | null = null;
  let newest: Audit | null = null;
  for (const audit of candidates) {
    if (newest === null || (audit.created_at ?? "") >= (newest.created_at ?? "")) {
      newest = audit;
    }
    if (
      audit.status === "completed" &&
      (completed === null || completionStamp(audit) >= completionStamp(completed))
    ) {
      completed = audit;
    }
  }
  return completed ?? newest;
}

/** Group audits by business (order preserved) for a per-lead pickDisplayAudit. */
export function groupAuditsByBusiness(
  audits: readonly Audit[],
): Map<string, Audit[]> {
  const byBusiness = new Map<string, Audit[]>();
  for (const audit of audits) {
    const list = byBusiness.get(audit.business_id);
    if (list) list.push(audit);
    else byBusiness.set(audit.business_id, [audit]);
  }
  return byBusiness;
}

/**
 * Write-time rule for the pointer (RFL.WEB.10): a completed audit always
 * takes the pointer; a pending/failed/skipped one takes it only while the
 * row does not already point at a completed audit. So a forced re-audit
 * that hangs or fails never knocks a lead back to "could not audit".
 */
export function shouldRepointLatestAudit(
  current: Pick<Audit, "status"> | null,
  next: Pick<Audit, "status"> | null,
): boolean {
  if (next === null || next.status === "completed") return true;
  return current?.status !== "completed";
}
