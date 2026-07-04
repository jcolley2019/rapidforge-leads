import {
  BarChart3,
  Bot,
  LayoutGrid,
  List,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";

/** Left-rail views (PRD 7.2). All stubs in Sprint 1. */
export type ViewKey =
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
  { key: "pipeline", label: "Pipeline", icon: LayoutGrid },
  { key: "new-search", label: "New Search", icon: Search },
  { key: "leads", label: "Leads", icon: List },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: Settings },
];
