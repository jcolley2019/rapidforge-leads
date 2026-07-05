import {
  BarChart3,
  Bot,
  LayoutGrid,
  List,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";

/**
 * App views. The left rail lists VIEWS below; 'live-search' is reached
 * only by submitting a search (PRD 7.3) and has no rail entry.
 */
export type ViewKey =
  | "pipeline"
  | "new-search"
  | "live-search"
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
  { key: "pipeline", label: "Pipeline", icon: LayoutGrid },
  { key: "new-search", label: "New Search", icon: Search },
  { key: "leads", label: "Leads", icon: List },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: Settings },
];
