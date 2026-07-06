import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { VIEWS, type ViewKey } from "@/views/views";

interface LeftRailProps {
  active: ViewKey;
  collapsed: boolean;
  onNavigate: (view: ViewKey) => void;
  onToggleCollapsed: () => void;
}

/** Collapsible glass rail (PRD 7.2, Glass v2). */
export function LeftRail({
  active,
  collapsed,
  onNavigate,
  onToggleCollapsed,
}: LeftRailProps) {
  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-background/95 transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
      )}
      aria-label="Primary"
    >
      <ul className="flex flex-1 flex-col gap-1 p-2">
        {VIEWS.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key} className="relative">
              {isActive && (
                <motion.span
                  layoutId="rail-active"
                  transition={spring.default}
                  className="absolute inset-0 rounded-xl bg-accent"
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => onNavigate(key)}
                title={collapsed ? label : undefined}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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

      <div className="p-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand rail" : "Collapse rail"}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
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
