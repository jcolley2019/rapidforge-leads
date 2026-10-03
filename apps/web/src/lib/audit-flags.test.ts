import { describe, expect, it } from "vitest";
import { failedAuditReason, isFailedAudit, isProvisionalAudit } from "./audit-flags";

describe("audit flags", () => {
  it("isFailedAudit only for status 'failed'", () => {
    expect(isFailedAudit({ status: "failed" })).toBe(true);
    for (const status of ["pending", "skipped", "completed", null]) {
      expect(isFailedAudit({ status })).toBe(false);
    }
    expect(isFailedAudit(null)).toBe(false);
  });

  it("failedAuditReason uses error_message, with a fallback", () => {
    expect(
      failedAuditReason({ error_message: "stale: reclaimed after worker restart" }),
    ).toBe("stale: reclaimed after worker restart");
    expect(failedAuditReason({ error_message: null })).toBe(
      "The audit did not complete",
    );
    expect(failedAuditReason({ error_message: "  " })).toBe(
      "The audit did not complete",
    );
  });

  it("isProvisionalAudit only when the column is true (absent column = false)", () => {
    expect(isProvisionalAudit({ provisional: true })).toBe(true);
    expect(isProvisionalAudit({ provisional: false })).toBe(false);
    expect(isProvisionalAudit({ provisional: null })).toBe(false);
    expect(isProvisionalAudit({})).toBe(false);
    expect(isProvisionalAudit(undefined)).toBe(false);
  });
});
