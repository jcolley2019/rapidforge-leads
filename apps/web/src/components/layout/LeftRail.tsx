import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { VIEWS, type ViewKey } from "@/views/views";

interface LeftRailProps {
  active: ViewKey;
  collapsed: boolean;
  onNavigate: (view: ViewKey) => void;
  onToggleCollapsed: () => void;
}

/** Collapsible left rail (PRD 7.2): Pipeline, New Search, Leads, Agents, Analytics, Settings. */
export function LeftRail({
  active,
  collapsed,
  onNavigate,
  onToggleCollapsed,
}: LeftRailProps) {
  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r bg-card transition-[width] duration-200",
        collapsed ? "w-12" : "w-52",
      )}
      aria-label="Primary"
    >
      <ul className="flex flex-1 flex-col gap-0.5 p-1.5">
        {VIEWS.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onNavigate(key)}
                title={collapsed ? label : undefined}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  collapsed && "justify-center px-0",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {!collapsed && <span>{label}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="p-1.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand rail" : "Collapse rail"}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
