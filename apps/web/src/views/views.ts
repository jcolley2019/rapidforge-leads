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

const viewByKey = new Map(VIEWS.map((v) => [v.key, v]));

export function viewDef(key: ViewKey): ViewDef {
  const def = viewByKey.get(key);
  if (!def) throw new Error(`unknown view: ${key}`);
  return def;
}

/** Rail sections with uppercase micro-headers (DESIGN_NOTES v3 §5). */
export interface ViewGroup {
  header: string;
  keys: ViewKey[];
}

export const RAIL_GROUPS: ViewGroup[] = [
  { header: "Prospecting", keys: ["workspace", "new-search"] },
  { header: "Pipeline", keys: ["pipeline", "leads"] },
  { header: "Intelligence", keys: ["agents", "analytics"] },
  { header: "Account", keys: ["settings"] },
];
