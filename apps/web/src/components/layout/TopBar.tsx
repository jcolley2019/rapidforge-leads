import { CircleHelp, LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import { useLive } from "@/features/live/useWorkspaceLive";
import { fetchUsage } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const USAGE_REFRESH_MS = 60_000;

interface TopBarProps {
  /** Signed-in user email; null in offline preview / signed-out states. */
  userEmail: string | null;
  onSignOut: () => void;
  /** Opens the cmd-K palette (PRD 7.5). */
  onOpenPalette: () => void;
  /** Usage meter deep-links to Analytics (PRD 7.2). */
  onOpenAnalytics: () => void;
  /** The ? button opens the Help view (RFL.HELP.4). */
  onOpenHelp: () => void;
}

/**
 * Top bar (PRD 7.2, Glass v2): brand, workspace chip, connection state,
 * cmd-K trigger, live usage meter, Help, theme toggle, account.
 */
export function TopBar({
  userEmail,
  onSignOut,
  onOpenPalette,
  onOpenAnalytics,
  onOpenHelp,
}: TopBarProps) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const { connection } = useLive();

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background/95 px-6">
      <div className="flex items-center gap-2.5">
        <span
          className="h-4 w-4 rounded-md bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.5)]"
          aria-hidden
        />
        {/* Logotype is the ONLY Orbitron in the product (brand rule). */}
        <span className="font-display text-sm font-bold tracking-[0.08em] text-foreground">
          RapidForge
        </span>
      </div>

      {/* Workspace switcher placeholder (single workspace in v1) */}
      <span className="rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground">
        My Workspace
      </span>

      {userEmail && <ConnectionDot connection={connection} />}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden rounded-lg border border-border/80 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground sm:inline"
        title="Command palette"
        aria-label="Open command palette (Ctrl K)"
      >
        Ctrl K
      </button>

      <UsageMeter onClick={onOpenAnalytics} />

      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenHelp}
        title="Help"
        aria-label="Help"
      >
        <CircleHelp />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(toggleTheme())}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>

      {userEmail ? (
        <div className="flex items-center gap-2">
          <span className="max-w-[180px] truncate text-xs text-muted-foreground">
            {userEmail}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onSignOut}
            title="Sign out"
          >
            <LogOut />
          </Button>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">offline preview</span>
      )}
    </header>
  );
}

/**
 * Current-month usage_events rollup (PRD 7.2). Refreshes every minute and
 * after any lead mutation; failures degrade to an em-dash, never break the
 * bar. Click deep-links to Analytics.
 */
function UsageMeter({ onClick }: { onClick: () => void }) {
  const { leadsVersion } = useLeadDrawer();
  const [totalCents, setTotalCents] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const summary = await fetchUsage();
        if (!cancelled) setTotalCents(summary.total_cents);
      } catch {
        if (!cancelled) setTotalCents(null);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), USAGE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [leadsVersion]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
      title="This month's API spend — open Analytics"
      aria-label="Monthly usage — open Analytics"
    >
      {totalCents === null ? "$—.—" : formatCents(totalCents)} / mo
    </button>
  );
}

/** Live connection state (PRD 5.6): green live, amber reconnect+polling. */
function ConnectionDot({
  connection,
}: {
  connection: "connecting" | "live" | "reconnecting";
}) {
  const live = connection === "live";
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={
        live
          ? "Realtime connected"
          : "Realtime reconnecting — polling keeps data fresh"
      }
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          live ? "bg-agent-complete" : "bg-agent-waiting animate-pulse",
        )}
        aria-hidden
      />
      {live ? "Live" : "Reconnecting"}
    </span>
  );
}
