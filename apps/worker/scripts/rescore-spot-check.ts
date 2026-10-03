/**
 * RFL-05 spot check — READ-ONLY against Supabase.
 *
 * Takes the audit's section (d) businesses (plus the three the brief names)
 * by name, recomputes sellability from the STORED audit health and Places
 * reputation with the current computeSellabilityScore, and prints a table:
 * name, health, rating, reviews, old sellability, new sellability, cap
 * reason, analyst_eligible before/after.
 *
 *   Run from apps/worker:  npx tsx scripts/rescore-spot-check.ts
 *   Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/worker/.env.
 *
 * Nothing is written. Rows whose stored data cannot support the recompute
 * are listed as such rather than approximated.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  computeSellabilityScore,
  type Audit,
  type Business,
} from "@rapidforge/shared";
import {
  ANALYST_MAX_STAR_GRADE,
  ANALYST_SELLABILITY_THRESHOLD,
  analystEligible,
} from "../src/orchestrator";

/** Audit (d) spot-check rows + the three named in the RFL-05 brief. */
const NAMES = [
  "SG Plumbing",
  "Boise Plumbing & Drain Clean Co",
  "Steve's Service Plumbing",
  "Smile Plumbing",
  "Meridian Plumbing, Heating and Air",
  "Veterans Plumbing",
  "Roto-Rooter Plumbing & Water Cleanup",
  "Home Services at The Home Depot",
  "Blum Family Plumbing",
  "Sweet's Sewer Drain & Cleaning",
  "Express Plumbing",
  "Five Star Service Pros",
  "Ulta Beauty",
];

/** Pre-RFL-05 auto-run rule: sellability ≥ 60 and not a chain (RFL-04). */
function eligibleBefore(audit: Audit, business: Business): boolean {
  return (
    audit.sellability_score !== null &&
    audit.sellability_score >= ANALYST_SELLABILITY_THRESHOLD &&
    business.is_chain !== true
  );
}

interface Row {
  name: string;
  health: string;
  rating: string;
  reviews: string;
  old: string;
  new: string;
  cap: string;
  before: string;
  after: string;
  note: string;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — this script reads the live project and needs the worker env.",
    );
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const rows: Row[] = [];
  for (const name of NAMES) {
    const { data: businesses, error } = await db
      .from("businesses")
      .select("*")
      .ilike("name", `%${name.replace(/[%_]/g, "")}%`)
      .order("last_refreshed_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`businesses ${name}: ${error.message}`);
    const business = (businesses ?? [])[0] as Business | undefined;
    if (!business) {
      rows.push(blank(name, "business not found by name"));
      continue;
    }
    const { data: audits, error: auditErr } = await db
      .from("audits")
      .select("*")
      .eq("business_id", business.id)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);
    if (auditErr) throw new Error(`audits ${name}: ${auditErr.message}`);
    const audit = (audits ?? [])[0] as Audit | undefined;
    if (!audit) {
      rows.push(blank(business.name, "no completed audit"));
      continue;
    }

    const kind = business.website_kind ?? "unknown";
    const isHotLead = kind === "none" || kind === "social_only";
    // A real-site audit with no stored health cannot be recomputed: the
    // health term is half the score. (Hot leads legitimately have null health.)
    if (!isHotLead && audit.website_health_score === null) {
      rows.push({
        ...blank(business.name, "stored audit has null website_health_score — cannot recompute"),
        old: fmt(audit.sellability_score),
      });
      continue;
    }
    const blocked =
      audit.provisional === true ||
      (audit.score_breakdown as { health?: { blocked?: boolean } } | null)?.health
        ?.blocked === true;

    const result = computeSellabilityScore({
      websiteKind: isHotLead ? kind : "real",
      healthScore: audit.website_health_score,
      reviewCount: business.review_count,
      googleRating: business.google_rating,
      hasPhone: business.phone !== null,
      isChain: business.is_chain === true,
      businessStatus: business.business_status,
      siteBlocked: blocked,
    });

    const before = eligibleBefore(audit, business);
    const after = analystEligible({
      starGrade: audit.star_grade,
      sellabilityScore: result.score,
      isChain: business.is_chain === true,
      provisional: blocked,
    });
    rows.push({
      name: business.name,
      health: fmt(audit.website_health_score),
      rating: fmt(business.google_rating),
      reviews: fmt(business.review_count),
      old: fmt(audit.sellability_score),
      new: String(result.score),
      cap: result.breakdown.capped ?? (result.breakdown.specialCase ?? "-"),
      before: before ? "yes" : "no",
      after: after ? "yes" : "no",
      note: [
        business.is_chain ? `chain(${business.chain_reason ?? "?"})` : null,
        blocked ? "provisional" : null,
        result.breakdown.reputationUnknown ? "reputation unknown" : null,
        audit.star_grade !== null && audit.star_grade > ANALYST_MAX_STAR_GRADE
          ? `${audit.star_grade}★`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  printTable(rows);
}

function blank(name: string, note: string): Row {
  return {
    name,
    health: "-",
    rating: "-",
    reviews: "-",
    old: "-",
    new: "-",
    cap: "-",
    before: "-",
    after: "-",
    note,
  };
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? "null" : String(v);
}

function printTable(rows: Row[]): void {
  const headers: Array<[keyof Row, string]> = [
    ["name", "name"],
    ["health", "health"],
    ["rating", "rating"],
    ["reviews", "reviews"],
    ["old", "old sell"],
    ["new", "new sell"],
    ["cap", "cap"],
    ["before", "analyst before"],
    ["after", "analyst after"],
    ["note", "note"],
  ];
  const widths = headers.map(([k, h]) =>
    Math.max(h.length, ...rows.map((r) => r[k].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  console.log(line(headers.map(([, h]) => h)));
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const r of rows) console.log(line(headers.map(([k]) => r[k])));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
