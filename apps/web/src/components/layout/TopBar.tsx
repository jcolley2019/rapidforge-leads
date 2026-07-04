import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TopBarProps {
  /** Signed-in user email; null in offline preview / signed-out states. */
  userEmail: string | null;
  onSignOut: () => void;
}

/**
 * Top bar (PRD 7.2): workspace switcher, cmd-K hint, usage meter, account.
 * Sprint 1: static placeholders for switcher/cmd-K/usage — wired in
 * Sprints 4–5.
 */
export function TopBar({ userEmail, onSignOut }: TopBarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-sm bg-primary" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">RapidForge</span>
      </div>

      {/* Workspace switcher placeholder (single workspace in v1) */}
      <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
        My Workspace
      </span>

      <div className="flex-1" />

      {/* cmd-K hint — palette lands Sprint 5 */}
      <span
        className="hidden rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline"
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
