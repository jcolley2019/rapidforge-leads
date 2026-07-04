import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { LeftRail } from "@/components/layout/LeftRail";
import { TopBar } from "@/components/layout/TopBar";
import { AuthPage } from "@/features/auth/AuthPage";
import { useAuth } from "@/features/auth/useAuth";
import { AgentsView } from "@/views/AgentsView";
import { AnalyticsView } from "@/views/AnalyticsView";
import { LeadsView } from "@/views/LeadsView";
import { NewSearchView } from "@/views/NewSearchView";
import { PipelineView } from "@/views/PipelineView";
import { SettingsView } from "@/views/SettingsView";
import type { ViewKey } from "@/views/views";

function renderView(view: ViewKey) {
  switch (view) {
    case "pipeline":
      return <PipelineView />;
    case "new-search":
      return <NewSearchView />;
    case "leads":
      return <LeadsView />;
    case "agents":
      return <AgentsView />;
    case "analytics":
      return <AnalyticsView />;
    case "settings":
      return <SettingsView />;
  }
}

export function App() {
  const { auth, signOut } = useAuth();
  // Pipeline is the default view (PRD 7.3).
  const [view, setView] = useState<ViewKey>("pipeline");
  const [collapsed, setCollapsed] = useState(false);

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (auth.status === "signed_out") {
    return <AuthPage />;
  }

  // signed_in → real shell; unconfigured → offline preview of the same
  // shell with a banner (fresh clones must run without env — Sprint 1).
  const userEmail =
    auth.status === "signed_in" ? (auth.session.user.email ?? null) : null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {auth.status === "unconfigured" && (
        <div className="flex items-center gap-2 border-b border-agent-waiting/40 bg-agent-waiting/10 px-4 py-1.5 text-xs text-agent-waiting">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Supabase is not configured — copy <code>apps/web/.env.example</code>{" "}
            to <code>apps/web/.env</code>, fill in the values, and restart.
            Running in offline preview.
          </span>
        </div>
      )}

      <TopBar userEmail={userEmail} onSignOut={() => void signOut()} />

      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          active={view}
          collapsed={collapsed}
          onNavigate={setView}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
        />
        <main className="flex-1 overflow-y-auto p-6">{renderView(view)}</main>
      </div>
    </div>
  );
}
