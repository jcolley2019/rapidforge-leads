import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { LeftRail } from "@/components/layout/LeftRail";
import { TopBar } from "@/components/layout/TopBar";
import { LeadDrawer } from "@/components/leads/LeadDrawer";
import { AuthPage } from "@/features/auth/AuthPage";
import { useAuth } from "@/features/auth/useAuth";
import { LeadDrawerProvider } from "@/features/leads/LeadDrawerContext";
import {
  LiveContext,
  useWorkspaceLive,
} from "@/features/live/useWorkspaceLive";
import { AgentsView } from "@/views/AgentsView";
import { AnalyticsView } from "@/views/AnalyticsView";
import { LeadsView } from "@/views/LeadsView";
import { NewSearchView } from "@/views/NewSearchView";
import { PipelineView } from "@/views/PipelineView";
import { SettingsView } from "@/views/SettingsView";
import { WorkspaceView } from "@/views/WorkspaceView";
import type { ViewKey } from "@/views/views";

export function App() {
  const { auth, signOut } = useAuth();
  // Workspace is the primary page (Sprint 4).
  const [view, setView] = useState<ViewKey>("workspace");
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Submitting a search routes to the Workspace view for that id.
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);

  // One Realtime subscription per signed-in session (PRD 5.6).
  const workspaceId =
    auth.status === "signed_in" ? auth.workspaceId : null;
  const liveValue = useWorkspaceLive(workspaceId);

  function renderView(current: ViewKey) {
    switch (current) {
      case "workspace":
        return (
          <WorkspaceView
            searchId={activeSearchId}
            onNewSearch={() => setView("new-search")}
          />
        );
      case "pipeline":
        return <PipelineView />;
      case "new-search":
        return (
          <NewSearchView
            onSearchCreated={(searchId) => {
              setActiveSearchId(searchId);
              setView("workspace");
            }}
          />
        );
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
    <LiveContext.Provider value={liveValue}>
      <LeadDrawerProvider>
      <div className="flex h-screen flex-col text-foreground">
        {auth.status === "unconfigured" && (
          <div className="flex items-center gap-2 border-b border-agent-waiting/30 bg-agent-waiting/10 px-6 py-1.5 text-xs text-agent-waiting">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Supabase is not configured — copy{" "}
              <code>apps/web/.env.example</code> to <code>apps/web/.env</code>,
              fill in the values, and restart. Running in offline preview.
            </span>
          </div>
        )}

        <TopBar
          userEmail={userEmail}
          onSignOut={() => void signOut()}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenAnalytics={() => setView("analytics")}
        />

        <div className="flex flex-1 overflow-hidden">
          <LeftRail
            active={view}
            collapsed={collapsed}
            onNavigate={setView}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
          />
          <main className="flex-1 overflow-y-auto p-8">
            {renderView(view)}
          </main>
        </div>

        <LeadDrawer />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onNavigate={setView}
        />
      </div>
      </LeadDrawerProvider>
    </LiveContext.Provider>
  );
}
