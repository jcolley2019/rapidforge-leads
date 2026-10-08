/**
 * cmd-K command palette (PRD 7.5, cmdk) — jump to lead by name, new
 * search, switch view, toggle theme, export CSV, re-audit selected.
 * Ctrl/⌘-K toggles; leads load lazily on first open.
 */
import { Command } from "cmdk";
import {
  Download,
  Moon,
  RefreshCw,
  Search,
  Sun,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import {
  fetchWorkspaceLeads,
  reauditBusiness,
  type LeadView,
} from "@/lib/api";
import { downloadCsv, leadsToCsv } from "@/lib/csv";
import { getTheme, toggleTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { VIEWS, type ViewKey } from "@/views/views";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: ViewKey) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
}: CommandPaletteProps) {
  const { openLead, selectedLeadIds, notifyLeadsChanged, leadsVersion } = useLeadDrawer();
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Ctrl/⌘-K toggles from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === "Escape" && open) onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) setNotice(null);
  }, [open]);

  // Lazy lead list for "jump to lead" — refreshed each open, and while open
  // whenever leads change (a finished re-audit, RFL.VERIFY.3 V6).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchWorkspaceLeads()
      .then((rows) => {
        if (!cancelled) setLeads(rows);
      })
      .catch(() => {
        if (!cancelled) setLeads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, leadsVersion]);

  function run(action: () => void) {
    action();
    onOpenChange(false);
  }

  async function reauditSelected() {
    if (!leads) return;
    const businessIds = [
      ...new Set(
        leads
          .filter((l) => selectedLeadIds.has(l.result.id))
          .map((l) => l.business.id),
      ),
    ];
    let ok = 0;
    for (const id of businessIds) {
      try {
        await reauditBusiness(id, { force: false });
        ok += 1;
      } catch {
        // partial success surfaces in the notice below
      }
    }
    setNotice(`Re-audit queued for ${ok}/${businessIds.length} businesses`);
    notifyLeadsChanged();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="glass w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" loop>
          <Command.Input
            autoFocus
            placeholder="Jump to a lead, switch views, run an action…"
            className="h-12 w-full border-b border-border/70 bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches.
            </Command.Empty>

            <Group heading="Actions">
              <Item
                icon={<Search className="h-4 w-4" aria-hidden />}
                onSelect={() => run(() => onNavigate("new-search"))}
              >
                New search
              </Item>
              <Item
                icon={
                  getTheme() === "dark" ? (
                    <Sun className="h-4 w-4" aria-hidden />
                  ) : (
                    <Moon className="h-4 w-4" aria-hidden />
                  )
                }
                onSelect={() => run(() => void toggleTheme())}
              >
                Toggle theme
              </Item>
              <Item
                icon={<Download className="h-4 w-4" aria-hidden />}
                onSelect={() =>
                  run(() => {
                    if (leads && leads.length > 0) {
                      downloadCsv(
                        `rapidforge-leads-${new Date().toISOString().slice(0, 10)}.csv`,
                        leadsToCsv(leads),
                      );
                    }
                  })
                }
              >
                Export all leads to CSV
              </Item>
              {selectedLeadIds.size > 0 && (
                <Item
                  icon={<RefreshCw className="h-4 w-4" aria-hidden />}
                  onSelect={() => void reauditSelected()}
                >
                  Re-audit {selectedLeadIds.size} selected lead
                  {selectedLeadIds.size === 1 ? "" : "s"}
                </Item>
              )}
            </Group>

            <Group heading="Go to">
              {VIEWS.map(({ key, label, icon: Icon }) => (
                <Item
                  key={key}
                  icon={<Icon className="h-4 w-4" aria-hidden />}
                  onSelect={() => run(() => onNavigate(key))}
                >
                  {label}
                </Item>
              ))}
            </Group>

            <Group heading="Leads">
              {(leads ?? []).slice(0, 200).map((lead) => (
                <Item
                  key={lead.result.id}
                  icon={<UserRound className="h-4 w-4" aria-hidden />}
                  onSelect={() => run(() => openLead(lead))}
                  keywords={[lead.business.phone ?? ""]}
                >
                  <span className="truncate">{lead.business.name}</span>
                  {lead.audit?.sellability_score !== null &&
                    lead.audit?.sellability_score !== undefined && (
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {lead.audit.sellability_score}
                      </span>
                    )}
                </Item>
              ))}
            </Group>
          </Command.List>
          {notice && (
            <p className="border-t border-border/70 px-4 py-2 text-xs text-agent-complete">
              {notice}
            </p>
          )}
          <div className="flex items-center gap-3 border-t border-border/70 px-4 py-2 font-mono text-[10px] text-muted-foreground">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Group({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  icon,
  children,
  onSelect,
  keywords,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
  keywords?: string[];
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm",
        "data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
        "text-muted-foreground",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </Command.Item>
  );
}
