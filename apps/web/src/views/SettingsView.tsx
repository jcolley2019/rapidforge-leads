/**
 * Settings (PRD 7.3, Glass v2) — the cascading agent variables editor
 * (workspace_config via GET/PUT /api/config; RLS update policy is
 * migration 0005), search defaults (localStorage → New Search), and the
 * persisted theme preference. API keys are NOT here — worker env only
 * (CLAUDE.md Section 9).
 */
import { Check, Loader2, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { UpdateWorkspaceConfigRequest } from "@rapidforge/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchConfig, saveConfig } from "@/lib/api";
import {
  getSearchDefaults,
  saveSearchDefaults,
} from "@/lib/search-defaults";
import { applyTheme, getTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** The six cascading variables (CLAUDE.md 6.4) with operator-facing copy. */
const VARIABLE_FIELDS: Array<{
  key: keyof UpdateWorkspaceConfigRequest;
  label: string;
  placeholder: string;
  multiline?: boolean;
}> = [
  {
    key: "your_offer",
    label: "Your offer",
    placeholder: "Website rebuilds + local SEO for service businesses",
    multiline: true,
  },
  {
    key: "target_industry",
    label: "Target industry",
    placeholder: "Home services (plumbing, HVAC, electrical…)",
  },
  {
    key: "ideal_website_traits",
    label: "Ideal website traits",
    placeholder: "Fast, mobile-first, booking-enabled, review-forward",
    multiline: true,
  },
  {
    key: "sales_tone",
    label: "Sales tone",
    placeholder: "direct, friendly, peer-to-peer, no-BS",
  },
  {
    key: "user_location",
    label: "Your location",
    placeholder: "Boise, ID",
  },
  {
    key: "user_brand",
    label: "Your brand",
    placeholder: "RapidForgeAI",
  },
];

type ConfigDraft = Record<keyof UpdateWorkspaceConfigRequest, string>;

const EMPTY_DRAFT: ConfigDraft = {
  your_offer: "",
  target_industry: "",
  ideal_website_traits: "",
  sales_tone: "",
  user_location: "",
  user_brand: "",
};

export function SettingsView() {
  const [draft, setDraft] = useState<ConfigDraft>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<ConfigDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<"saved" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaults = getSearchDefaults();
  const [defaultRadius, setDefaultRadius] = useState(
    defaults?.radius_miles ?? 10,
  );
  const [defaultCategory, setDefaultCategory] = useState(
    defaults?.category_type ?? "plumber",
  );
  const [theme, setTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((config) => {
        if (cancelled) return;
        const next: ConfigDraft = {
          your_offer: config.your_offer ?? "",
          target_industry: config.target_industry ?? "",
          ideal_website_traits: config.ideal_website_traits ?? "",
          sales_tone: config.sales_tone ?? "",
          user_location: config.user_location ?? "",
          user_brand: config.user_brand ?? "",
        };
        setDraft(next);
        setSaved(next);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(
    () =>
      VARIABLE_FIELDS.some(({ key }) => draft[key] !== saved[key]),
    [draft, saved],
  );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const patch: UpdateWorkspaceConfigRequest = {};
      for (const { key } of VARIABLE_FIELDS) {
        const value = draft[key].trim();
        patch[key] = value === "" ? null : value;
      }
      await saveConfig(patch);
      setSaved({ ...draft });
      setFlash("saved");
      window.setTimeout(() => setFlash(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function updateDefaults(radius: number, category: string) {
    setDefaultRadius(radius);
    setDefaultCategory(category);
    saveSearchDefaults({ radius_miles: radius, category_type: category });
  }

  function switchTheme(next: Theme) {
    applyTheme(next);
    setTheme(next);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
          Account
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cascading variables</CardTitle>
          <CardDescription>
            Every agent prompt receives these through one shared template —
            tune them once, every deliverable adapts (Analyst, Builder Brief,
            Sales Summary…).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
              Loading configuration…
            </p>
          ) : (
            <>
              {VARIABLE_FIELDS.map(({ key, label, placeholder, multiline }) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`cfg-${key}`}>
                    {label}{" "}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {"{" + key + "}"}
                    </span>
                  </Label>
                  {multiline ? (
                    <textarea
                      id={`cfg-${key}`}
                      value={draft[key]}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      placeholder={placeholder}
                      rows={2}
                      className="w-full resize-y rounded-xl border border-input bg-transparent px-3.5 py-2 text-sm outline-none ring-primary/40 placeholder:text-muted-foreground/60 focus:ring-2"
                    />
                  ) : (
                    <Input
                      id={`cfg-${key}`}
                      value={draft[key]}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      placeholder={placeholder}
                    />
                  )}
                </div>
              ))}
              <div className="flex items-center gap-3 border-t border-border pt-4">
                <Button onClick={() => void save()} disabled={!dirty || saving}>
                  {saving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  ) : flash === "saved" ? (
                    <Check className="mr-2 h-4 w-4" aria-hidden />
                  ) : null}
                  {flash === "saved" ? "Saved" : "Save variables"}
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground">
                    Unsaved changes
                  </span>
                )}
              </div>
            </>
          )}
          {error && (
            <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search defaults</CardTitle>
          <CardDescription>
            Pre-filled on every New Search. Stored locally on this machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="default-radius">
              Default radius{" "}
              <span className="font-mono text-primary">{defaultRadius} mi</span>
            </Label>
            <input
              id="default-radius"
              type="range"
              min={1}
              max={25}
              step={1}
              value={defaultRadius}
              onChange={(e) =>
                updateDefaults(Number(e.target.value), defaultCategory)
              }
              className="w-full accent-[hsl(var(--primary))]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-category">Default category type</Label>
            <Input
              id="default-category"
              value={defaultCategory}
              onChange={(e) =>
                updateDefaults(defaultRadius, e.target.value)
              }
              placeholder="plumber"
              className="font-mono"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>
            Persisted to this browser and applied before first paint.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          {(
            [
              { value: "dark", label: "Dark", icon: Moon },
              { value: "light", label: "Light", icon: Sun },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => switchTheme(value)}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-4 py-2 text-sm transition-colors",
                theme === value
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={theme === value}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
