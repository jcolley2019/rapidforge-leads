/**
 * PDF audit report (Sprint 7, PRD 7 / Sprint 7 collateral) — a 2-page,
 * client-ready sales deliverable rendered from a completed audit.
 *
 * Two parts, mirroring the screenshots seam:
 *   - buildReportHtml(): a PURE, self-contained branded HTML document (all
 *     CSS inline, A4, two print pages). Unit-testable without Chrome.
 *   - ReportRenderer: html → bytes. Real = puppeteer-core → PDF (the local
 *     Chrome, same channel as screenshots). Fixture/no-Chrome = the HTML
 *     itself (text/html) — still presentable and printable, and CI needs no
 *     browser. Selection is logged like every other seam.
 *
 * RFL.QUEUE.8a: the PDF path shares the browser module AND its switch —
 * live mode without SCREENSHOTS_ENABLED=true selects the disabled renderer
 * and the route answers 503 "screenshots disabled" (never a hang).
 */
import type { Audit, Business } from "@rapidforge/shared";
import { BrowserUnavailableError, withPage } from "./browser";
import { forceFixtures, screenshotsEnabled } from "./env";
import { screenshotSlug } from "./screenshots";

export interface ReportAnalyst {
  verdict: string;
  one_line_verdict: string;
  top_3_improvements: Array<{
    priority: number;
    improvement: string;
    rationale: string;
    estimated_impact: string;
  }>;
}

export interface ReportInput {
  business: Business;
  audit: Audit;
  analyst: ReportAnalyst | null;
  /** Absolute "today" for the report date — injected for determinism. */
  generatedAt: Date;
}

export interface ReportOutput {
  bytes: Buffer;
  contentType: "application/pdf" | "text/html";
  extension: "pdf" | "html";
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stars(grade: number | null): string {
  if (grade === null) return "—";
  const n = Math.round(grade);
  return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
}

/** Only absolute image URLs embed in the PDF (relative fixture URLs can't). */
function absoluteImg(url: string | null, alt: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  return `<img src="${esc(url)}" alt="${esc(alt)}" />`;
}

/** Pure, self-contained branded report HTML (A4, two print pages). */
export function buildReportHtml(input: ReportInput): string {
  const { business, audit, analyst } = input;
  const date = input.generatedAt.toISOString().slice(0, 10);
  const health = audit.website_health_score;
  const sell = audit.sellability_score;
  const issues = (audit.issues ?? []).slice(0, 6);

  const improvements = analyst?.top_3_improvements ?? [];
  const improvementsHtml =
    improvements.length > 0
      ? improvements
          .map(
            (i) => `<li>
        <div class="imp-h">${i.priority}. ${esc(i.improvement)}</div>
        <div class="imp-b">${esc(i.rationale)}</div>
        <div class="imp-i">Impact: ${esc(i.estimated_impact)}</div>
      </li>`,
          )
          .join("\n")
      : issues
          .map(
            (i, n) => `<li>
        <div class="imp-h">${n + 1}. ${esc(i.label)}</div>
        <div class="imp-b">${esc(i.detail ?? "Flagged in the audit.")}</div>
      </li>`,
          )
          .join("\n");

  const issuesHtml =
    issues.length > 0
      ? issues
          .map(
            (i) =>
              `<li class="sev-${i.severity}"><span class="sev">${i.severity}</span>${esc(i.label)}</li>`,
          )
          .join("\n")
      : `<li>No blocking issues — a well-built site.</li>`;

  const desktopImg = absoluteImg(
    audit.screenshot_desktop_url,
    "Desktop homepage",
  );
  const mobileImg = absoluteImg(audit.screenshot_mobile_url, "Mobile homepage");
  const shotsHtml =
    desktopImg || mobileImg
      ? `<div class="shots">${desktopImg}${mobileImg}</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(business.name)} — Website Audit</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0f172a; }
  .page { width: 210mm; min-height: 297mm; padding: 18mm 16mm; position: relative; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .brand { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1a8fff; padding-bottom: 10px; }
  .brand .logo { font-weight: 800; letter-spacing: .06em; color: #1a8fff; font-size: 15px; }
  .brand .date { color: #64748b; font-size: 11px; }
  h1 { font-size: 26px; margin: 22px 0 2px; }
  .sub { color: #64748b; font-size: 12px; margin-bottom: 18px; }
  .scores { display: flex; gap: 12px; margin: 8px 0 20px; }
  .score { flex: 1; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
  .score .k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
  .score .v { font-size: 30px; font-weight: 700; color: #1a8fff; }
  .score .stars { color: #eab308; font-size: 14px; letter-spacing: 2px; }
  .verdict { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
  .verdict .k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #1a8fff; }
  .verdict .v { font-size: 16px; font-weight: 600; margin-top: 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #334155; margin: 18px 0 8px; }
  ul { list-style: none; }
  .issues li { padding: 7px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .issues .sev { display: inline-block; min-width: 58px; font-size: 9px; text-transform: uppercase; font-weight: 700; margin-right: 8px; }
  .sev-high .sev { color: #ef4444; }
  .sev-medium .sev { color: #eab308; }
  .sev-low .sev { color: #64748b; }
  .shots { display: flex; gap: 10px; margin-top: 10px; }
  .shots img { max-width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 8px; }
  .shots img:last-child { max-width: 120px; }
  .imps li { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .imp-h { font-weight: 700; font-size: 14px; }
  .imp-b { color: #475569; font-size: 12px; margin-top: 3px; }
  .imp-i { color: #1a8fff; font-size: 11px; margin-top: 5px; font-weight: 600; }
  .signals { display: flex; flex-wrap: wrap; gap: 10px; }
  .signal { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; font-size: 12px; }
  .signal b { color: #0f172a; }
  .cta { margin-top: 22px; background: #1a8fff; color: #fff; border-radius: 12px; padding: 16px 18px; }
  .cta .h { font-weight: 700; font-size: 15px; }
  .cta .b { font-size: 12px; opacity: .9; margin-top: 4px; }
  .foot { position: absolute; bottom: 12mm; left: 16mm; right: 16mm; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
</style>
</head>
<body>
  <section class="page">
    <div class="brand"><span class="logo">RAPIDFORGE</span><span class="date">Website Audit · ${esc(date)}</span></div>
    <h1>${esc(business.name)}</h1>
    <div class="sub">${esc(business.address ?? business.website_url ?? "")}</div>

    <div class="scores">
      <div class="score"><div class="k">Website Health</div><div class="v">${health ?? "—"}</div><div class="stars">${stars(audit.star_grade)}</div></div>
      <div class="score"><div class="k">Sellability</div><div class="v">${sell ?? "—"}</div></div>
      <div class="score"><div class="k">Platform</div><div class="v" style="font-size:18px;padding-top:8px">${esc(audit.platform ?? "—")}</div></div>
    </div>

    ${
      analyst
        ? `<div class="verdict"><div class="k">Analyst verdict — ${esc(analyst.verdict.replace(/_/g, " "))}</div><div class="v">${esc(analyst.one_line_verdict)}</div></div>`
        : ""
    }

    <h2>What's holding the site back</h2>
    <ul class="issues">${issuesHtml}</ul>
    ${shotsHtml}
    <div class="foot">Prepared by RapidForge · Deterministic measurements + AI interpretation · Page 1 of 2</div>
  </section>

  <section class="page">
    <div class="brand"><span class="logo">RAPIDFORGE</span><span class="date">${esc(business.name)}</span></div>
    <h1 style="font-size:22px">The opportunity</h1>
    <div class="sub">The highest-impact fixes, prioritized.</div>
    <ul class="imps">${improvementsHtml}</ul>

    <h2>Key signals</h2>
    <div class="signals">
      <div class="signal"><b>Rating</b> ${business.google_rating ?? "—"}★ (${business.review_count ?? 0} reviews)</div>
      <div class="signal"><b>Phone</b> ${esc(business.phone ?? "—")}</div>
      <div class="signal"><b>Mobile speed</b> ${audit.ps_mobile_performance ?? "—"}/100</div>
      <div class="signal"><b>SSL</b> ${audit.ssl_valid ? "valid" : "issue"}</div>
    </div>

    <div class="cta">
      <div class="h">A modern rebuild would turn this site into your best salesperson.</div>
      <div class="b">Fast, mobile-first, one-tap calling and booking — built to convert the traffic you already earn. Let's talk about a free before/after mockup.</div>
    </div>
    <div class="foot">Prepared by RapidForge · This report reflects a point-in-time audit · Page 2 of 2</div>
  </section>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface ReportRenderer {
  readonly mode: "pdf" | "html" | "disabled";
  render(html: string): Promise<ReportOutput>;
}

/** The route's 503 body when the browser path is switched off. */
export const SCREENSHOTS_DISABLED_ERROR = "screenshots disabled";

export class PuppeteerReportRenderer implements ReportRenderer {
  readonly mode = "pdf" as const;

  /** Shared browser + 30s budget (RFL.QUEUE.8); no Chrome → HTML output. */
  async render(html: string): Promise<ReportOutput> {
    let pdf: Uint8Array;
    try {
      pdf = await withPage("report-pdf", REPORT_RENDER_TIMEOUT_MS, async (page) => {
        // setContent's typed waitUntil is load|domcontentloaded; "load" waits
        // for the self-contained doc's images (absolute URLs) before printing.
        await page.setContent(html, { waitUntil: "load" });
        return page.pdf({ format: "A4", printBackground: true });
      });
    } catch (err) {
      if (!(err instanceof BrowserUnavailableError)) throw err;
      console.warn(`[report] ${err.message} — serving HTML instead of PDF`);
      return new HtmlReportRenderer().render(html);
    }
    return {
      bytes: Buffer.from(pdf),
      contentType: "application/pdf",
      extension: "pdf",
    };
  }
}

export const REPORT_RENDER_TIMEOUT_MS = 30_000;

/** No Chrome: hand back the HTML — presentable in a browser, printable to PDF. */
export class HtmlReportRenderer implements ReportRenderer {
  readonly mode = "html" as const;

  async render(html: string): Promise<ReportOutput> {
    return {
      bytes: Buffer.from(html, "utf8"),
      contentType: "text/html",
      extension: "html",
    };
  }
}

/** Live mode with SCREENSHOTS_ENABLED off: the route answers 503. */
export class DisabledReportRenderer implements ReportRenderer {
  readonly mode = "disabled" as const;

  async render(): Promise<ReportOutput> {
    throw new Error(SCREENSHOTS_DISABLED_ERROR);
  }
}

let cached: ReportRenderer | null = null;

/** Same pairing as screenshots: real Chrome only when Places is live. */
export function createReportRenderer(): ReportRenderer {
  if (forceFixtures() || !process.env.GOOGLE_PLACES_API_KEY) {
    return new HtmlReportRenderer();
  }
  if (!screenshotsEnabled()) return new DisabledReportRenderer();
  return new PuppeteerReportRenderer();
}

/** Process-wide renderer (the route's only consumer; not in the pipeline). */
export function getReportRenderer(): ReportRenderer {
  if (cached === null) {
    cached = createReportRenderer();
    console.log(`[report] renderer mode: ${cached.mode}`);
  }
  return cached;
}

/** Tests: re-select the renderer from the current env on next use. */
export function resetReportRenderer(): void {
  cached = null;
}

/** Report filename stem from the site/business. */
export function reportFileStem(business: Business): string {
  const base = business.website_url
    ? screenshotSlug(business.website_url)
    : business.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "business"}-audit-report`;
}
