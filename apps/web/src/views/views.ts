import {
  Activity,
  BarChart3,
  Bot,
  LayoutGrid,
  List,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";

/**
 * App views. Workspace is the primary page (Sprint 4) — agent tabs, live
 * pipeline, results. The left rail lists VIEWS below.
 */
export type ViewKey =
  | "workspace"
  | "pipeline"
  | "new-search"
  | "leads"
  | "agents"
  | "analytics"
  | "settings";

export interface ViewDef {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
}

export const VIEWS: ViewDef[] = [
  { key: "workspace", label: "Workspace", icon: Activity },
  { key: "pipeline", label: "Pipeline", icon: LayoutGrid },
  { key: "new-search", label: "New Search", icon: Search },
  { key: "leads", label: "Leads", icon: List },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: Settings },
];
