/**
 * Build-demo tab helpers (RFL.DEMO.1) — pure, so the four tab states and the
 * default subdomain are unit-testable without a DOM.
 */
import type { DemoStatusResponse } from "@/lib/api";

/** A subdomain label under demos.rapidforge.ai — same rule as the worker. */
export const DEMO_SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The default sub: the business name's first DNS-safe word, lowercased —
 * "All Plumbing & Sewer" → "allplumbing" (the demos CLI's own default, so a
 * blank input and this prefill agree). Empty when nothing usable is left.
 */
export function defaultDemoSub(name: string): string {
  const head = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9 -]/)
    .map((part) =>
      part.replace(/\s+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, ""),
    )
    .find(Boolean);
  if (!head) return "";
  const sub = head.slice(0, 40).replace(/-+$/, "");
  return DEMO_SUB_RE.test(sub) ? sub : "";
}

export type DemoView =
  | { kind: "none" }
  | { kind: "building"; log: string[] }
  | {
      kind: "ready";
      url: string;
      previewUrl: string | null;
      builtAt: string | null;
      /** true → "public link goes live once DNS is set up" note. */
      dnsPending: boolean;
    }
  | { kind: "failed"; error: string };

/**
 * Which of the four tab states to show. `liveLog` (Realtime demo.log lines)
 * wins over the polled tail when it is at least as long — the socket is
 * ahead of the 3 s poll, and both come from the same worker buffer.
 */
export function demoView(
  status: DemoStatusResponse | null,
  liveLog: readonly string[] = [],
): DemoView {
  if (!status || !status.demo_status) return { kind: "none" };
  switch (status.demo_status) {
    case "building": {
      const polled = status.log ?? [];
      return {
        kind: "building",
        log: liveLog.length >= polled.length ? [...liveLog] : [...polled],
      };
    }
    case "ready":
      return {
        kind: "ready",
        url: status.demo_url ?? status.demo_preview_url ?? "",
        previewUrl: status.demo_preview_url,
        builtAt: status.demo_built_at,
        dnsPending: status.alias_ok === false,
      };
    case "failed":
      return { kind: "failed", error: status.demo_error ?? "Build failed" };
  }
}
