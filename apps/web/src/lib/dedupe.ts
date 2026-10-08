/**
 * Cross-search lead dedupe (S5.5). Businesses upsert on
 * (workspace_id, google_place_id), so the same place found by N searches
 * is ONE businesses row with N search_results — Pipeline and Leads views
 * show it once with a "seen in N searches" chip. The Workspace per-search
 * table stays un-deduped by design.
 *
 * Representative row (status/notes/follow-up):
 *   1. a worked row (non-null last_contacted_at) beats unworked rows —
 *      re-finding a lead in a new search never resets its pipeline state;
 *   2. among worked rows, the most recently contacted wins;
 *   3. otherwise the newest search_result (created_at) wins.
 * Scores: the LATEST audit across the group wins (completed_at, falling
 * back to created_at).
 */
import type { Audit } from "@rapidforge/shared";
import type { LeadView } from "@/lib/api";

export interface DedupedLead extends LeadView {
  /** Distinct searches this business appeared in. */
  seenIn: number;
}

function newerIso(a: string | null, b: string | null): boolean {
  return (a ?? "") > (b ?? "");
}

function pickRepresentative(group: LeadView[]): LeadView {
  let rep = group[0] as LeadView;
  for (const lead of group.slice(1)) {
    const repWorked = rep.result.last_contacted_at !== null;
    const leadWorked = lead.result.last_contacted_at !== null;
    if (leadWorked && !repWorked) {
      rep = lead;
    } else if (leadWorked && repWorked) {
      if (newerIso(lead.result.last_contacted_at, rep.result.last_contacted_at)) {
        rep = lead;
      }
    } else if (!leadWorked && !repWorked) {
      if (newerIso(lead.result.created_at, rep.result.created_at)) {
        rep = lead;
      }
    }
  }
  return rep;
}

function pickLatestAudit(group: LeadView[]): Audit | null {
  let latest: Audit | null = null;
  for (const lead of group) {
    const audit = lead.audit;
    if (!audit) continue;
    const stamp = audit.completed_at ?? audit.created_at;
    const latestStamp = latest ? (latest.completed_at ?? latest.created_at) : null;
    if (latest === null || newerIso(stamp, latestStamp)) latest = audit;
  }
  return latest;
}

export function dedupeLeads(leads: LeadView[]): DedupedLead[] {
  const groups = new Map<string, LeadView[]>();
  for (const lead of leads) {
    const list = groups.get(lead.business.id);
    if (list) list.push(lead);
    else groups.set(lead.business.id, [lead]);
  }

  const out: DedupedLead[] = [];
  for (const group of groups.values()) {
    const rep = pickRepresentative(group);
    out.push({
      ...rep,
      audit: pickLatestAudit(group),
      seenIn: new Set(group.map((l) => l.result.search_id)).size,
    });
  }

  // Mirror the worker's lead ordering: sellability desc, nulls last, name.
  return out.sort((a, b) => {
    const sa = a.audit?.sellability_score ?? null;
    const sb = b.audit?.sellability_score ?? null;
    if (sa === null && sb === null)
      return a.business.name.localeCompare(b.business.name);
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sb !== sa) return sb - sa;
    return a.business.name.localeCompare(b.business.name);
  });
}

/**
 * The reloaded row an open drawer should move onto (same search_result id,
 * new object), or null when the drawer is closed, already on it, or the row
 * is no longer listed. Pipeline reloads on leadsVersion, which every
 * lead.scored bumps, so a finished audit's scores reach the drawer
 * (RFL.FIX.3i.1, as Leads and Workspace do since 3i V6).
 */
export function freshDrawerLead<T extends LeadView>(
  rows: T[],
  open: LeadView | null,
): T | null {
  if (!open) return null;
  const fresh = rows.find((l) => l.result.id === open.result.id);
  return fresh && fresh !== open ? fresh : null;
}
