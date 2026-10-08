/**
 * Demo tab (RFL.DEMO.1) — one button builds and deploys the prospect's demo
 * site with rapidforge-demos on the worker's machine. Four states:
 *
 *   none     → explanation + "Build demo" (optional sub prefilled from the name)
 *   building → spinner + live log (Realtime demo.log events, 3 s poll fallback)
 *   ready    → public link big (Open / Copy), preview link small, built-at, Rebuild
 *   failed   → the error + "Try again"
 *
 * DemoTabView is the pure render (tested from props); DemoTab wires it to
 * the API, the live context and the poll.
 */
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import { useLive } from "@/features/live/useWorkspaceLive";
import {
  buildDemo,
  fetchDemoStatus,
  type DemoStatusResponse,
  type LeadView,
} from "@/lib/api";
import { DEMO_SUB_RE, defaultDemoSub, demoView, type DemoView } from "@/lib/demo";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const DEMO_POLL_MS = 3000;

/** Seed the first paint from the lead row — no flash of "no demo" on reopen. */
export function statusFromLead(lead: LeadView): DemoStatusResponse | null {
  const b = lead.business;
  if (!b.demo_status) return null;
  return {
    demo_status: b.demo_status,
    demo_url: b.demo_url ?? null,
    demo_preview_url: b.demo_preview_url ?? null,
    demo_sub: b.demo_sub ?? null,
    demo_built_at: b.demo_built_at ?? null,
    demo_error: b.demo_error ?? null,
    log: [],
    alias_ok: null,
  };
}

export function DemoTab({ lead }: { lead: LeadView }) {
  const businessId = lead.business.id;
  const { notifyLeadsChanged } = useLeadDrawer();
  const { live } = useLive();
  const [status, setStatus] = useState<DemoStatusResponse | null>(() =>
    statusFromLead(lead),
  );
  const [sub, setSub] = useState(() => defaultDemoSub(lead.business.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(status?.demo_status ?? null);
  // Realtime demo.log lines accumulate per business for the session; a new
  // build shows only the lines broadcast since it was started here.
  const liveLog = live.demoLogs[businessId] ?? [];
  const liveStart = useRef(0);

  // Reset when a different lead opens in the same mounted drawer.
  useEffect(() => {
    setStatus(statusFromLead(lead));
    setSub(defaultDemoSub(lead.business.name));
    setError(null);
    lastStatus.current = lead.business.demo_status ?? null;
  }, [lead.result.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDemoStatus(businessId);
      setStatus(next);
      // building → ready/failed: the list row's Demo chip needs a refetch.
      if (
        lastStatus.current === "building" &&
        next.demo_status !== "building"
      ) {
        notifyLeadsChanged();
      }
      lastStatus.current = next.demo_status;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [businessId, notifyLeadsChanged]);

  // Load on open; poll every 3 s while building (fallback to Realtime).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const building = status?.demo_status === "building";
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(), DEMO_POLL_MS);
    return () => clearInterval(timer);
  }, [building, refresh]);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      liveStart.current = liveLog.length;
      await buildDemo(businessId, sub.trim() || undefined);
      lastStatus.current = "building";
      setStatus((prev) => ({
        demo_status: "building",
        demo_url: prev?.demo_url ?? null,
        demo_preview_url: prev?.demo_preview_url ?? null,
        demo_sub: prev?.demo_sub ?? null,
        demo_built_at: prev?.demo_built_at ?? null,
        demo_error: null,
        log: [],
        alias_ok: null,
      }));
    } catch (err) {
      // 409 (already building) and friends land here — shown, never thrown.
      setError(err instanceof Error ? err.message : String(err));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  const view = demoView(status, liveLog.slice(liveStart.current));
  const subValid = sub.trim() === "" || DEMO_SUB_RE.test(sub.trim());

  return (
    <DemoTabView
      view={view}
      sub={sub}
      subValid={subValid}
      onSubChange={setSub}
      busy={busy}
      error={error}
      onBuild={() => void build()}
    />
  );
}

export interface DemoTabViewProps {
  view: DemoView;
  sub: string;
  subValid: boolean;
  onSubChange: (sub: string) => void;
  busy: boolean;
  error: string | null;
  onBuild: () => void;
}

export function DemoTabView({
  view,
  sub,
  subValid,
  onSubChange,
  busy,
  error,
  onBuild,
}: DemoTabViewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>Demo site</SectionTitle>
        {view.kind === "ready" && (
          <Button variant="outline" size="sm" onClick={onBuild} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            Rebuild
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-agent-error">{error}</p>}

      {view.kind === "none" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Builds a live demo site for this prospect from its Design Brief —
            five visual variants behind a picker, deployed to Vercel and aliased
            under demos.rapidforge.ai. Generates the brief first if there is
            none. Takes one to two minutes.
          </p>
          <SubField sub={sub} valid={subValid} onChange={onSubChange} disabled={busy} />
          <Button onClick={onBuild} disabled={busy || !subValid}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Globe className="h-4 w-4" aria-hidden />
            )}
            {busy ? "Starting…" : "Build demo"}
          </Button>
        </div>
      )}

      {view.kind === "building" && (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
            Building…
          </p>
          <DemoLog lines={view.log} />
          <Button disabled>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Build demo
          </Button>
        </div>
      )}

      {view.kind === "ready" && (
        <div className="space-y-3">
          <div className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
            <a
              href={view.url}
              target="_blank"
              rel="noreferrer"
              className="block break-all text-base font-semibold text-primary hover:underline"
            >
              {view.url.replace(/^https?:\/\//, "")}
            </a>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => window.open(view.url, "_blank", "noopener")}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open
              </Button>
              <CopyButton text={view.url} />
            </div>
            {view.dnsPending && (
              <p className="mt-2 text-xs text-muted-foreground">
                public link goes live once DNS is set up
              </p>
            )}
          </div>
          {view.previewUrl && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              <a
                href={view.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
                title={view.previewUrl}
              >
                {view.previewUrl.replace(/^https?:\/\//, "")}
              </a>{" "}
              · preview (Vercel login)
            </p>
          )}
          {view.builtAt && (
            <p className="font-mono text-[11px] text-muted-foreground">
              built {relativeTime(view.builtAt) ?? ""} ·{" "}
              {new Date(view.builtAt).toLocaleString()}
            </p>
          )}
          <SubField sub={sub} valid={subValid} onChange={onSubChange} disabled={busy} />
        </div>
      )}

      {view.kind === "failed" && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-agent-error/50 bg-agent-error/10 px-4 py-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-agent-error" aria-hidden />
            <p className="break-words font-mono text-xs text-agent-error">{view.error}</p>
          </div>
          <SubField sub={sub} valid={subValid} onChange={onSubChange} disabled={busy} />
          <Button onClick={onBuild} disabled={busy || !subValid}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function SubField({
  sub,
  valid,
  onChange,
  disabled,
}: {
  sub: string;
  valid: boolean;
  onChange: (sub: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor="demo-sub"
        className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
      >
        Subdomain
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id="demo-sub"
          value={sub}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="allplumbing"
          className={cn("h-8 max-w-[200px] font-mono text-xs", !valid && "border-agent-error")}
          spellCheck={false}
        />
        <span className="font-mono text-xs text-muted-foreground">.demos.rapidforge.ai</span>
      </div>
      {!valid && (
        <p className="text-[11px] text-agent-error">
          lowercase a-z, 0-9 and hyphens only (1–40 characters)
        </p>
      )}
    </div>
  );
}

function DemoLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      className="max-h-64 overflow-y-auto rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
      aria-live="polite"
      aria-label="Demo build log"
    >
      {lines.length === 0 ? "Starting the build…" : lines.join("\n")}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — nothing to do; the link is selectable above
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}
