import { LogOut, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useLive } from "@/features/live/useWorkspaceLive";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface TopBarProps {
  /** Signed-in user email; null in offline preview / signed-out states. */
  userEmail: string | null;
  onSignOut: () => void;
}

/**
 * Top bar (PRD 7.2, Glass v2): brand, workspace chip, connection state,
 * theme toggle, account. cmd-K + usage meter land Sprint 5.
 */
export function TopBar({ userEmail, onSignOut }: TopBarProps) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const { connection } = useLive();

  return (
    <header className="glass sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-x-0 border-t-0 px-6">
      <div className="flex items-center gap-2.5">
        <span
          className="h-4 w-4 rounded-md bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.5)]"
          aria-hidden
        />
        <span className="text-[15px] font-semibold tracking-tight">
          RapidForge
        </span>
      </div>

      {/* Workspace switcher placeholder (single workspace in v1) */}
      <span className="rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground">
        My Workspace
      </span>

      {userEmail && <ConnectionDot connection={connection} />}

      <div className="flex-1" />

      {/* cmd-K hint — palette lands Sprint 5 */}
      <span
        className="hidden rounded-lg border border-border/80 px-2 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline"
        title="Command palette — Sprint 5"
      >
        Ctrl K
      </span>

      {/* Usage meter placeholder — wired to usage_events in Sprint 5 */}
      <span
        className="font-mono text-xs text-muted-foreground"
        title="Monthly API spend — wired in Sprint 5"
      >
        $0.00 / mo
      </span>

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
