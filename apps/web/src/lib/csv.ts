/**
 * CSV export for lead lists (PRD 7.3 bulk actions). RFC 4180: CRLF line
 * endings, fields quoted when they contain a comma, quote, or newline;
 * quotes doubled. Null/undefined render as empty fields — never "null".
 */
import type { LeadView } from "@/lib/api";

export const CSV_HEADERS = [
  "name",
  "phone",
  "address",
  "website",
  "website_kind",
  "rating",
  "reviews",
  "category",
  "health",
  "stars",
  "sellability",
  "status",
  "last_contacted_at",
  "next_followup_at",
  "notes",
] as const;

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function leadToCsvRow(lead: LeadView): string[] {
  const { business, audit, result } = lead;
  return [
    business.name,
    business.phone ?? "",
    business.address ?? "",
    business.website_url ?? "",
    business.website_kind ?? "unknown",
    business.google_rating?.toString() ?? "",
    business.review_count?.toString() ?? "",
    business.category ?? "",
    audit?.website_health_score?.toString() ?? "",
    audit?.star_grade?.toString() ?? "",
    audit?.sellability_score?.toString() ?? "",
    result.status ?? "new",
    result.last_contacted_at ?? "",
    result.next_followup_at ?? "",
    result.notes ?? "",
  ];
}

export function leadsToCsv(leads: LeadView[]): string {
  const lines = [
    CSV_HEADERS.map(csvField).join(","),
    ...leads.map((lead) => leadToCsvRow(lead).map(csvField).join(",")),
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Browser download via a temporary object URL. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
