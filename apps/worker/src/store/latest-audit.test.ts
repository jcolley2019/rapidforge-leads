/**
 * Display-audit resolution (RFL.WEB.10): the newest COMPLETED audit wins over
 * a newer failed/pending one; the raw pointer is never consulted.
 */
import { describe, expect, it } from "vitest";
import type { Audit } from "@rapidforge/shared";
import {
  groupAuditsByBusiness,
  pickDisplayAudit,
  shouldRepointLatestAudit,
} from "./latest-audit";

function audit(overrides: Partial<Audit> & { id: string }): Audit {
  return {
    business_id: "biz-1",
    status: "completed",
    created_at: "2026-10-04T07:00:00.000Z",
    completed_at: "2026-10-04T07:34:00.000Z",
    sellability_score: 55,
    website_health_score: 72,
    ...overrides,
  } as Audit;
}

describe("pickDisplayAudit", () => {
  it("picks the completed audit over a newer failed one (Accurbore)", () => {
    const completed = audit({ id: "aaa0e4ce" });
    const failed = audit({
      id: "failed-later",
      status: "failed",
      created_at: "2026-10-05T01:00:00.000Z",
      completed_at: null,
      sellability_score: null,
      website_health_score: null,
    });
    const pending = audit({
      id: "pending-latest",
      status: "pending",
      created_at: "2026-10-05T02:00:00.000Z",
      completed_at: null,
    });
    expect(pickDisplayAudit([failed, completed, pending])?.id).toBe("aaa0e4ce");
  });

  it("picks the NEWEST completed audit when several completed", () => {
    const older = audit({ id: "older", completed_at: "2026-09-01T00:00:00.000Z" });
    const newer = audit({ id: "newer", completed_at: "2026-10-01T00:00:00.000Z" });
    expect(pickDisplayAudit([newer, older])?.id).toBe("newer");
    expect(pickDisplayAudit([older, newer])?.id).toBe("newer");
  });

  it("falls back to the newest of any status when nothing completed", () => {
    const failedOld = audit({
      id: "f-old",
      status: "failed",
      created_at: "2026-10-01T00:00:00.000Z",
      completed_at: null,
    });
    const pendingNew = audit({
      id: "p-new",
      status: "pending",
      created_at: "2026-10-02T00:00:00.000Z",
      completed_at: null,
    });
    expect(pickDisplayAudit([failedOld, pendingNew])?.id).toBe("p-new");
  });

  it("returns null for a business with no audits", () => {
    expect(pickDisplayAudit([])).toBeNull();
  });

  it("groups by business so each lead resolves independently", () => {
    const grouped = groupAuditsByBusiness([
      audit({ id: "a", business_id: "biz-1" }),
      audit({ id: "b", business_id: "biz-2", status: "failed", completed_at: null }),
      audit({ id: "c", business_id: "biz-1", status: "pending", completed_at: null }),
    ]);
    expect(pickDisplayAudit(grouped.get("biz-1") ?? [])?.id).toBe("a");
    expect(pickDisplayAudit(grouped.get("biz-2") ?? [])?.id).toBe("b");
  });
});

describe("shouldRepointLatestAudit", () => {
  it("a completed audit always takes the pointer", () => {
    expect(shouldRepointLatestAudit({ status: "completed" }, { status: "completed" })).toBe(true);
    expect(shouldRepointLatestAudit({ status: "failed" }, { status: "completed" })).toBe(true);
    expect(shouldRepointLatestAudit(null, { status: "completed" })).toBe(true);
  });

  it("a failed or pending audit never overwrites a completed pointer", () => {
    expect(shouldRepointLatestAudit({ status: "completed" }, { status: "failed" })).toBe(false);
    expect(shouldRepointLatestAudit({ status: "completed" }, { status: "pending" })).toBe(false);
  });

  it("a pending audit may take an empty or non-completed pointer (first audit, retry)", () => {
    expect(shouldRepointLatestAudit(null, { status: "pending" })).toBe(true);
    expect(shouldRepointLatestAudit({ status: "pending" }, { status: "pending" })).toBe(true);
    expect(shouldRepointLatestAudit({ status: "failed" }, { status: "pending" })).toBe(true);
  });
});
