/**
 * Cascading variables (CLAUDE.md 6.4) — the ONE place workspace_config turns
 * into prompt values. Every agent that personalizes a prompt ({your_offer},
 * {target_industry}, {ideal_website_traits}, {sales_tone}, {user_location},
 * {user_brand}) resolves them here, never inlining a hardcoded fallback.
 *
 * A blank/absent config field falls back to a sensible default (aligned with
 * PRD Section 13 — e.g. the "direct, friendly, peer-to-peer, no-BS" tone), so
 * a fresh workspace still produces usable copy.
 */
import type { WorkspaceConfig } from "@rapidforge/shared";

export interface CascadingVars {
  your_offer: string;
  target_industry: string;
  ideal_website_traits: string;
  sales_tone: string;
  user_location: string;
  user_brand: string;
}

/** Defaults for a workspace that hasn't filled in Settings yet. */
export const CONFIG_DEFAULTS: CascadingVars = {
  your_offer: "a fast, modern, mobile-first website rebuild",
  target_industry: "local service businesses",
  ideal_website_traits:
    "fast on mobile, clear calls-to-action, click-to-call, easy booking, trust signals",
  sales_tone: "direct, friendly, peer-to-peer, no-BS",
  user_location: "the local area",
  user_brand: "RapidForgeAI",
};

function pick(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

/** Resolve a (possibly null) workspace_config row into filled variables. */
export function resolveConfigVars(
  config: WorkspaceConfig | null,
): CascadingVars {
  return {
    your_offer: pick(config?.your_offer, CONFIG_DEFAULTS.your_offer),
    target_industry: pick(
      config?.target_industry,
      CONFIG_DEFAULTS.target_industry,
    ),
    ideal_website_traits: pick(
      config?.ideal_website_traits,
      CONFIG_DEFAULTS.ideal_website_traits,
    ),
    sales_tone: pick(config?.sales_tone, CONFIG_DEFAULTS.sales_tone),
    user_location: pick(config?.user_location, CONFIG_DEFAULTS.user_location),
    user_brand: pick(config?.user_brand, CONFIG_DEFAULTS.user_brand),
  };
}

// ---------------------------------------------------------------------------
// Per-business prompt variables ({category}, {city}) — same ONE-place rule
// as the workspace variables above (RFL.FIX.3c). Places types are snake_case
// ("general_contractor"); prompts, templates and keywords must never print
// the raw token.
// ---------------------------------------------------------------------------

export interface LocalTargetVars {
  /** Humanised category: "general contractor", never "general_contractor". */
  category: string | null;
  city: string | null;
}

/** "general_contractor" → "general contractor"; null stays null. */
export function humanizeCategory(category: string | null | undefined): string | null {
  const trimmed = category?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/_+/g, " ").replace(/\s+/g, " ").toLowerCase();
}

export function resolveLocalTarget(
  category: string | null | undefined,
  city: string | null | undefined,
): LocalTargetVars {
  return { category: humanizeCategory(category), city: city?.trim() || null };
}

/**
 * The search phrase a prompt or template names as the local target:
 * "general contractor in Nampa"; falls back to what is known.
 */
export function describeLocalTarget(target: LocalTargetVars): string {
  if (target.category && target.city) return `${target.category} in ${target.city}`;
  if (target.category) return `${target.category} (city unknown)`;
  if (target.city) return `local services in ${target.city} (category unknown)`;
  return "the business's category in its city (both unknown)";
}
