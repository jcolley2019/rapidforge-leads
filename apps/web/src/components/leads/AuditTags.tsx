/**
 * Audit state chips (RFL-03): "Could not audit" for failed audits and a
 * "provisional" tag for placeholder (bot-blocked) scores. Styled to match
 * the existing state chips and the ×N pill.
 */
import { cn } from "@/lib/utils";

/** Muted chip; the failure reason shows on hover. */
export function CouldNotAuditChip({ reason }: { reason: string }) {
  return (
    <span
      className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
      title={reason}
    >
      Could not audit
    </span>
  );
}

/** Small pill beside a score that was not actually measured. */
export function ProvisionalTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-1 rounded-full border border-border px-1.5 align-middle font-mono text-[10px] font-normal text-muted-foreground",
        className,
      )}
      title="Provisional — bot protection blocked the audit, so this score is a neutral placeholder, not a measurement"
    >
      provisional
    </span>
  );
}
