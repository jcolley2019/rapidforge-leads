/**
 * Re-audit one lead (RFL.WEB.10 §3). POSTs the existing
 * /api/businesses/:id/reaudit with force=true (bypasses the 30-day cache),
 * then follows the job through the workspace's live agent events: "Queued…"
 * until the first agent.started for the business, the newest agent.progress
 * line while it runs, "Re-audited" once the events stop — at which point the
 * lists refetch (leadsVersion). Disabled while any job for the business is
 * queued or running, whoever queued it.
 */
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import { useLive } from "@/features/live/useWorkspaceLive";
import {
  isBusinessInFlight,
  latestActivityFor,
  reauditDisabled,
  reauditPhase,
} from "@/lib/agent-state";
import { reauditBusiness } from "@/lib/api";
import { cn } from "@/lib/utils";

/** How long "Re-audited" shows before the button is armed again. */
const DONE_RESET_MS = 4000;

export interface ReauditButtonProps {
  businessId: string;
  /** Icon-only row action (Workspace table). Default: labelled drawer button. */
  compact?: boolean;
  className?: string;
}

export function ReauditButton({ businessId, compact = false, className }: ReauditButtonProps) {
  const { live } = useLive();
  const { notifyLeadsChanged } = useLeadDrawer();
  const [posting, setPosting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [seenRunning, setSeenRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = isBusinessInFlight(live, businessId);
  const activity = latestActivityFor(live, businessId);
  const phase = reauditPhase({ requested, seenRunning, inFlight });

  // A different lead in the same mounted button: start over.
  useEffect(() => {
    setRequested(false);
    setSeenRunning(false);
    setError(null);
  }, [businessId]);

  useEffect(() => {
    if (requested && inFlight) setSeenRunning(true);
  }, [requested, inFlight]);

  useEffect(() => {
    if (phase !== "done") return;
    notifyLeadsChanged(); // fresh scores into Workspace / Leads / drawer
    const timer = setTimeout(() => {
      setRequested(false);
      setSeenRunning(false);
    }, DONE_RESET_MS);
    return () => clearTimeout(timer);
  }, [phase, notifyLeadsChanged]);

  async function click(e: MouseEvent) {
    e.stopPropagation(); // the row click opens the drawer — not this
    if (posting || reauditDisabled(phase)) return;
    setPosting(true);
    setError(null);
    try {
      await reauditBusiness(businessId, { force: true });
      setSeenRunning(false);
      setRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  const disabled = posting || reauditDisabled(phase);
  const progress =
    phase === "running"
      ? (activity?.message ?? `${activity?.agent ?? "audit"} running…`)
      : phase === "queued"
        ? "Queued — waiting for a worker slot"
        : phase === "done"
          ? "Re-audit finished — scores refreshed"
          : "Run a fresh audit now (ignores the 30-day cache)";
  const label =
    phase === "running"
      ? `Auditing · ${activity?.agent ?? "…"}`
      : phase === "queued"
        ? "Queued…"
        : phase === "done"
          ? "Re-audited"
          : "Re-audit";
  const Icon = phase === "done" ? Check : RefreshCw;
  const busy = posting || phase === "queued" || phase === "running";

  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", className)}
        onClick={(e) => void click(e)}
        disabled={disabled}
        title={error ?? progress}
        aria-label={`${label} — ${progress}`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        ) : (
          <Icon className={cn("h-3.5 w-3.5", error && "text-agent-error")} aria-hidden />
        )}
      </Button>
    );
  }

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <Button
        variant="outline"
        size="sm"
        onClick={(e) => void click(e)}
        disabled={disabled}
        title={progress}
        aria-live="polite"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Icon className="h-3.5 w-3.5" aria-hidden />
        )}
        {label}
      </Button>
      {(phase === "running" || phase === "queued") && (
        <p className="max-w-[220px] truncate font-mono text-[10px] text-muted-foreground" title={progress}>
          {progress}
        </p>
      )}
      {error && <p className="text-xs text-agent-error">{error}</p>}
    </div>
  );
}
