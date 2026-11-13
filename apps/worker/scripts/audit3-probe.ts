/**
 * RFL.AUDIT.3 operating probe — keys, upstreams, data health.
 *
 *   Run from apps/worker:  npx tsx scripts/audit3-probe.ts <mode>
 *     keys   — Part 2: Anthropic, Google Places, PageSpeed, Supabase, plus
 *              what the PUBLIC anon key and the shipped Maps browser key can do
 *     data   — Part 3: read-only selects (counts, stuck work, agent_runs,
 *              workspace_config blanks, usage_events)
 *
 * Reads apps/worker/.env through dotenv. NO key value is ever printed — only
 * PASS/FAIL, counts, ids, timestamps and the upstream's own error text.
 *
 * Writes nothing. Spend: one Haiku call of a few tokens (< 0.01¢). The Places
 * calls ask for `places.id` only (the IDs-only SKU, no charge); PSI is free.
 * RPC probes pass random uuids, and the only function called with a role that
 * may execute it (delete_search, service role) raises search_not_found before
 * its first delete.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  callModel,
  MODEL_FABLE,
  MODEL_HAIKU,
  MODEL_OPUS,
  MODEL_SONNET,
} from "../src/lib/ai";

const WEB_URL = "https://app.rapidforgeai.com";
const SINCE_AGENT_RUNS = "2026-10-25T00:00:00Z";
const HOUR_MS = 3_600_000;

function line(ok: boolean | null, name: string, detail: string): void {
  const tag = ok === null ? "INFO" : ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name} — ${detail}`);
}

function clip(text: string, n = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** Every row of a select, 1000 at a time (PostgREST's default page cap). */
async function all<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

function tally<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

function serviceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** What the public can see: the shipped bundle's anon JWT and Maps key. */
async function shippedBundle(): Promise<{ anonJwt: string | null; mapsKeys: string[]; js: string }> {
  const html = await (await fetch(`${WEB_URL}/`)).text();
  const paths = [...html.matchAll(/\/assets\/[^"]+\.js/g)].map((m) => m[0]);
  let js = "";
  for (const p of new Set(paths)) js += await (await fetch(`${WEB_URL}${p}`)).text();
  const jwts = [...new Set(js.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? [])];
  const anon =
    jwts.find((j) => {
      try {
        const payload = JSON.parse(Buffer.from(j.split(".")[1], "base64url").toString("utf8")) as { role?: string };
        return payload.role === "anon";
      } catch {
        return false;
      }
    }) ?? null;
  const mapsKeys = [...new Set(js.match(/AIza[0-9A-Za-z_-]{35}/g) ?? [])];
  return { anonJwt: anon, mapsKeys, js };
}

// ---------------------------------------------------------------------------
// Part 2 — keys and upstreams
// ---------------------------------------------------------------------------

async function anthropicModels(key: string): Promise<{ ok: boolean; ids: string[]; err: string }> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) return { ok: false, ids: [], err: `HTTP ${res.status} ${clip(await res.text())}` };
  const body = (await res.json()) as { data?: { id: string }[] };
  return { ok: true, ids: (body.data ?? []).map((m) => m.id), err: "" };
}

async function probeAnthropic(): Promise<void> {
  const effective = process.env.ANTHROPIC_API_KEY ?? "";
  let fileKey = "";
  try {
    fileKey = parseDotenv(readFileSync(".env")).ANTHROPIC_API_KEY ?? "";
  } catch {
    fileKey = "";
  }
  const sameAsFile = fileKey !== "" && fileKey === effective;
  line(
    null,
    "Anthropic key source",
    effective === ""
      ? "no key in the environment"
      : sameAsFile
        ? "apps/worker/.env (no shell override)"
        : fileKey === ""
          ? "shell/Windows environment (apps/worker/.env has none)"
          : "shell/Windows environment OVERRIDES a different key in apps/worker/.env (dotenv never overrides)",
  );
  const constants = { MODEL_HAIKU, MODEL_SONNET, MODEL_OPUS, MODEL_FABLE };

  if (effective) {
    const m = await anthropicModels(effective);
    if (!m.ok) line(false, "Anthropic models list (effective key)", m.err);
    else {
      const missing = Object.entries(constants).filter(([, id]) => !m.ids.some((x) => x === id || x.startsWith(`${id}-`)));
      line(
        missing.length === 0,
        "Anthropic models list (effective key)",
        `${m.ids.length} models offered; ` +
          Object.entries(constants)
            .map(([name, id]) => `${name}=${id}:${missing.some(([n]) => n === name) ? "MISSING" : "offered"}`)
            .join(", "),
      );
    }
    try {
      const started = Date.now();
      const r = await callModel({ model: MODEL_HAIKU, prompt: "Reply with the single word OK.", maxTokens: 16 });
      line(
        r.stopReason === "end_turn",
        "Anthropic Haiku call through lib/ai.ts",
        `model=${r.modelUsed} stop=${r.stopReason} tokens=${r.tokensUsed} cost_microcents=${r.costMicrocents} ${Date.now() - started}ms text=${JSON.stringify(clip(r.text, 20))}`,
      );
    } catch (err) {
      line(false, "Anthropic Haiku call through lib/ai.ts", clip(err instanceof Error ? err.message : String(err)));
    }
  } else {
    line(false, "Anthropic models list (effective key)", "ANTHROPIC_API_KEY not set");
  }

  if (fileKey && !sameAsFile) {
    const m = await anthropicModels(fileKey);
    line(m.ok, "Anthropic models list (apps/worker/.env file key)", m.ok ? `${m.ids.length} models offered` : m.err);
  }
}

async function placesSearchText(key: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; count: number }> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id",
      ...headers,
    },
    body: JSON.stringify({ textQuery: "plumber Nampa ID", maxResultCount: 1 }),
  });
  const body = await res.text();
  let count = 0;
  try {
    count = ((JSON.parse(body) as { places?: unknown[] }).places ?? []).length;
  } catch {
    count = 0;
  }
  return { status: res.status, body, count };
}

function googleError(body: string): string {
  try {
    const e = (JSON.parse(body) as { error?: { status?: string; message?: string; details?: { reason?: string }[] } }).error;
    const reason = e?.details?.map((d) => d.reason).filter(Boolean).join(",");
    return clip(`${e?.status ?? ""} ${reason ?? ""} ${e?.message ?? ""}`);
  } catch {
    return clip(body);
  }
}

async function probePlaces(bundle: { mapsKeys: string[] }): Promise<void> {
  const key = process.env.GOOGLE_PLACES_API_KEY ?? "";
  if (!key) line(false, "Google Places searchText (server key)", "GOOGLE_PLACES_API_KEY not set");
  else {
    const r = await placesSearchText(key);
    line(
      r.status === 200 && r.count === 1,
      "Google Places searchText (server key)",
      r.status === 200 ? `HTTP 200, ${r.count} place returned` : `HTTP ${r.status} ${googleError(r.body)}`,
    );
  }
  line(bundle.mapsKeys.length <= 1, "Shipped bundle Google keys", `${bundle.mapsKeys.length} distinct AIza key(s) in the built JS`);
  for (const browserKey of bundle.mapsKeys) {
    line(browserKey !== key, "Shipped Maps key is not the server Places key", browserKey !== key ? "different keys" : "SAME KEY — server key is public");
    for (const [label, hdr] of [
      ["no referrer", {}],
      ["Referer https://evil.example/", { Referer: "https://evil.example/" }],
    ] as const) {
      const r = await placesSearchText(browserKey, hdr);
      line(
        r.status !== 200,
        `Shipped Maps key refused for Places searchText (${label})`,
        r.status === 200 ? "HTTP 200 — key is usable off-site for paid Places calls" : `HTTP ${r.status} ${googleError(r.body)}`,
      );
    }
  }
}

async function probePsi(): Promise<void> {
  const key = process.env.PAGESPEED_API_KEY ?? "";
  if (!key) return line(false, "PageSpeed mobile run", "PAGESPEED_API_KEY not set");
  const qs = new URLSearchParams({ url: "https://example.com", strategy: "mobile", key, category: "performance" });
  const started = Date.now();
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`);
  const body = await res.text();
  if (!res.ok) return line(false, "PageSpeed mobile run", `HTTP ${res.status} ${googleError(body)}`);
  const perf = (JSON.parse(body) as { lighthouseResult?: { categories?: { performance?: { score?: number } } } })
    .lighthouseResult?.categories?.performance?.score;
  line(typeof perf === "number", "PageSpeed mobile run", `HTTP 200, example.com mobile performance=${perf === undefined ? "?" : Math.round(perf * 100)} in ${Date.now() - started}ms`);
}

const EXPECTED_MIGRATIONS = [
  "0001_tenancy", "0002_domain", "0003_operational", "0004_rls", "0005_update_policies",
  "0006_screenshots_bucket", "0007_enrichment_and_indexes", "0007a_audits_provisional",
  "0008_businesses_chain_reason", "0009_purge_fixture_rows", "0010_business_demo", "0011_delete_helpers",
];

const TABLES = [
  "plans", "workspaces", "workspace_members", "workspace_config", "searches", "businesses",
  "search_results", "audits", "jobs", "agent_runs", "usage_events", "schema_migrations",
] as const;

async function probeSupabase(bundle: { anonJwt: string | null }): Promise<void> {
  const db = serviceClient();
  const ws = await db.from("workspaces").select("id", { count: "exact", head: true });
  line(!ws.error, "Supabase service-role select", ws.error ? clip(ws.error.message) : `workspaces count=${ws.count}`);

  const mig = await db.from("schema_migrations").select("version, applied_at").order("version");
  if (mig.error) line(false, "schema_migrations lists 0001–0011", clip(mig.error.message));
  else {
    const have = (mig.data as { version: string }[]).map((r) => r.version);
    const missing = EXPECTED_MIGRATIONS.filter((v) => !have.includes(v));
    line(missing.length === 0, "schema_migrations lists 0001–0011", `${have.length} rows; missing: ${missing.join(", ") || "none"}; extra: ${have.filter((v) => !EXPECTED_MIGRATIONS.includes(v)).join(", ") || "none"}`);
  }

  // Exists + executable by service role: raises search_not_found before any delete.
  const del = await db.rpc("delete_search", { p_workspace_id: randomUUID(), p_search_id: randomUUID() });
  line(
    del.error?.code === "P0002",
    "delete_search exists (service role)",
    del.error ? `code=${del.error.code} ${clip(del.error.message)}` : "returned without raising search_not_found?",
  );

  const url = process.env.SUPABASE_URL as string;
  if (!bundle.anonJwt) return line(false, "anon key probes", "no anon JWT found in the shipped bundle");
  const anon = createClient(url, bundle.anonJwt, { auth: { persistSession: false, autoRefreshToken: false } });

  for (const [fn, args] of [
    ["delete_search", { p_workspace_id: randomUUID(), p_search_id: randomUUID() }],
    ["clear_workspace_data", { p_workspace_id: randomUUID() }],
    ["bootstrap_workspace", {}],
    ["user_workspace_ids", {}],
  ] as const) {
    const r = await anon.rpc(fn, args);
    const denied = r.error?.code === "42501";
    line(denied, `anon cannot execute ${fn}`, r.error ? `code=${r.error.code} ${clip(r.error.message, 120)}` : "EXECUTED with the anon key");
  }
  line(null, "authenticated role on delete_search / clear_workspace_data", "not exercised live (needs a signed-in session; this probe writes nothing) — see 0011_delete_helpers.sql:146-149");

  // What the anon key (no session) reads through PostgREST.
  for (const t of TABLES) {
    const r = await anon.from(t).select("*", { count: "exact", head: true });
    const rows = r.count ?? 0;
    const expectOpen = t === "plans";
    line(
      r.error ? true : expectOpen ? true : rows === 0,
      `anon read ${t}`,
      r.error ? `refused: ${r.error.code ?? ""} ${clip(r.error.message, 100)}` : `${rows} row(s) visible${expectOpen ? " (world-readable by design, 0004_rls.sql:53)" : ""}`,
    );
  }
  const bucket = await anon.storage.from("screenshots").list("", { limit: 1000 });
  line(
    null,
    "anon list of the screenshots bucket",
    bucket.error ? `refused: ${clip(bucket.error.message, 100)}` : `${bucket.data.length} top-level folder(s) enumerable without sign-in`,
  );

  // Who can sign up (GoTrue public settings).
  const s = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: bundle.anonJwt } });
  if (!s.ok) line(false, "auth settings", `HTTP ${s.status}`);
  else {
    const j = (await s.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean; external?: Record<string, boolean> };
    const providers = Object.entries(j.external ?? {}).filter(([, on]) => on).map(([k]) => k);
    line(j.disable_signup === true, "Supabase sign-ups are closed", `disable_signup=${j.disable_signup} mailer_autoconfirm=${j.mailer_autoconfirm} providers=${providers.join(",")}`);
  }
  const users = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (users.error) line(null, "auth users", clip(users.error.message));
  else {
    const list = users.data.users;
    const members = await db.from("workspace_members").select("user_id, workspace_id, role");
    const memberIds = new Set(((members.data ?? []) as { user_id: string }[]).map((m) => m.user_id));
    line(
      null,
      "auth users",
      `${list.length} user(s); with a workspace: ${list.filter((u) => memberIds.has(u.id)).length}; created since 2026-10-11 (hosting): ${list.filter((u) => u.created_at >= "2026-10-11").length}; newest created ${list.map((u) => u.created_at).sort().pop() ?? "-"}; providers: ${JSON.stringify(tally(list, (u) => String(u.app_metadata?.provider ?? "?")))}`,
    );
  }
}

async function keys(): Promise<void> {
  const bundle = await shippedBundle();
  line(!/sk-ant-/.test(bundle.js) && !/service_role/.test(bundle.js) && !/sb_secret_/.test(bundle.js), "Shipped bundle secrets scan", `${bundle.js.length} bytes of JS; sk-ant-=${/sk-ant-/.test(bundle.js)} service_role=${/service_role/.test(bundle.js)} sb_secret_=${/sb_secret_/.test(bundle.js)}`);
  for (const step of [probeAnthropic, () => probePlaces(bundle), probePsi, () => probeSupabase(bundle)]) {
    try {
      await step();
    } catch (err) {
      line(false, "probe step threw", clip(err instanceof Error ? err.message : String(err)));
    }
  }
}

// ---------------------------------------------------------------------------
// Part 3 — data health
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  agent_name: string;
  status: string;
  model_used: string | null;
  tokens_used: number | null;
  cost_cents: number | null;
  guardrail_passed: boolean | null;
  guardrail_notes: string | null;
  error: string | null;
  started_at: string;
  job_id: string | null;
}

async function data(): Promise<void> {
  const db = serviceClient();
  const now = Date.now();
  const hourAgo = new Date(now - HOUR_MS).toISOString();
  console.log(`now=${new Date(now).toISOString()}`);

  const searches = await all<{ id: string; status: string; created_at: string; mode: string; category: string; workspace_id: string }>(
    (a, b) => db.from("searches").select("id, status, created_at, mode, category, workspace_id").order("created_at").range(a, b),
  );
  const businesses = await all<{ id: string; website_kind: string | null; is_chain: boolean | null; demo_status: string | null; workspace_id: string }>(
    (a, b) => db.from("businesses").select("id, website_kind, is_chain, demo_status, workspace_id").order("id").range(a, b),
  );
  const audits = await all<{ id: string; status: string; created_at: string; business_id: string }>(
    (a, b) => db.from("audits").select("id, status, created_at, business_id").order("created_at").range(a, b),
  );
  const jobs = await all<{ id: string; status: string; job_type: string; created_at: string; started_at: string | null; error: string | null }>(
    (a, b) => db.from("jobs").select("id, status, job_type, created_at, started_at, error").order("created_at").range(a, b),
  );
  const results = await all<{ id: string; business_id: string; search_id: string; latest_audit_id: string | null }>(
    (a, b) => db.from("search_results").select("id, business_id, search_id, latest_audit_id").order("id").range(a, b),
  );

  console.log("\n== counts ==");
  console.log(`workspaces with data: ${new Set(searches.map((s) => s.workspace_id)).size}`);
  console.log(`searches ${searches.length} by status ${JSON.stringify(tally(searches, (s) => s.status))}; by mode ${JSON.stringify(tally(searches, (s) => s.mode))}`);
  console.log(`  newest search ${searches.at(-1)?.created_at ?? "-"} (${searches.at(-1)?.status ?? "-"})`);
  console.log(`businesses ${businesses.length} by website_kind ${JSON.stringify(tally(businesses, (b) => String(b.website_kind)))}; is_chain ${businesses.filter((b) => b.is_chain).length}; demo_status ${JSON.stringify(tally(businesses, (b) => String(b.demo_status)))}`);
  console.log(`search_results ${results.length}`);
  console.log(`audits ${audits.length} by status ${JSON.stringify(tally(audits, (a) => a.status))}; newest ${audits.at(-1)?.created_at ?? "-"}`);
  console.log(`jobs ${jobs.length} by status ${JSON.stringify(tally(jobs, (j) => j.status))}; by type ${JSON.stringify(tally(jobs, (j) => j.job_type))}`);

  console.log("\n== stuck work (> 1 h) ==");
  const stuckSearches = searches.filter((s) => s.status !== "completed" && s.status !== "failed" && s.created_at < hourAgo);
  console.log(`searches not completed/failed and older than 1 h: ${stuckSearches.length}`);
  for (const s of stuckSearches.slice(0, 20)) console.log(`  search ${s.id} status=${s.status} created=${s.created_at}`);
  const stuckJobs = jobs.filter((j) => (j.status === "queued" || j.status === "running") && j.created_at < hourAgo);
  console.log(`jobs queued/running and older than 1 h: ${stuckJobs.length}`);
  for (const j of stuckJobs.slice(0, 20)) console.log(`  job ${j.id} ${j.job_type} status=${j.status} created=${j.created_at} started=${j.started_at}`);
  const stuckAudits = audits.filter((a) => !["completed", "failed", "skipped"].includes(a.status) && a.created_at < hourAgo);
  console.log(`audits not completed/failed/skipped and older than 1 h: ${stuckAudits.length} ${JSON.stringify(tally(stuckAudits, (a) => a.status))}`);
  for (const a of stuckAudits.slice(0, 10)) console.log(`  audit ${a.id} status=${a.status} created=${a.created_at}`);
  const failedJobErrors = tally(jobs.filter((j) => j.status === "failed"), (j) => clip(j.error ?? "(null)", 90));
  console.log(`failed job errors: ${JSON.stringify(failedJobErrors, null, 1)}`);

  console.log("\n== referential hygiene ==");
  const bizIds = new Set(businesses.map((b) => b.id));
  const auditIds = new Set(audits.map((a) => a.id));
  const referenced = new Set(results.map((r) => r.business_id));
  const orphanBiz = businesses.filter((b) => !referenced.has(b.id));
  console.log(`businesses with no search_results row: ${orphanBiz.length}${orphanBiz.length ? ` e.g. ${orphanBiz.slice(0, 3).map((b) => b.id).join(", ")}` : ""}`);
  const dangling = results.filter((r) => r.latest_audit_id && !auditIds.has(r.latest_audit_id));
  console.log(`search_results.latest_audit_id pointing at a missing audit: ${dangling.length}${dangling.length ? ` e.g. ${dangling.slice(0, 3).map((r) => r.id).join(", ")}` : ""}`);
  const bucket = await db.storage.from("screenshots").list("", { limit: 1000 });
  if (bucket.error) console.log(`screenshots bucket list failed: ${clip(bucket.error.message)}`);
  else {
    const folders = bucket.data.map((o) => o.name);
    const orphanFolders = folders.filter((f) => /^[0-9a-f-]{36}$/.test(f) && !bizIds.has(f));
    console.log(`screenshots bucket: ${folders.length} top-level folder(s)${folders.length === 1000 ? " (list capped at 1000)" : ""}; folders whose business row no longer exists: ${orphanFolders.length}${orphanFolders.length ? ` e.g. ${orphanFolders.slice(0, 3).join(", ")}` : ""}`);
  }

  console.log(`\n== agent_runs since ${SINCE_AGENT_RUNS} ==`);
  const runs = await all<RunRow>((a, b) =>
    db
      .from("agent_runs")
      .select("id, agent_name, status, model_used, tokens_used, cost_cents, guardrail_passed, guardrail_notes, error, started_at, job_id")
      .gte("started_at", SINCE_AGENT_RUNS)
      .order("started_at")
      .range(a, b),
  );
  console.log(`rows: ${runs.length}; by day ${JSON.stringify(tally(runs, (r) => r.started_at.slice(0, 10)))}`);
  const byAgent = new Map<string, RunRow[]>();
  for (const r of runs) byAgent.set(r.agent_name, [...(byAgent.get(r.agent_name) ?? []), r]);
  console.log("agent | runs | failed | running | guardrail_failed | model_used null | cost_cents | models");
  for (const [agent, rows] of [...byAgent.entries()].sort()) {
    console.log(
      [
        agent,
        rows.length,
        rows.filter((r) => r.status === "failed").length,
        rows.filter((r) => r.status === "running").length,
        rows.filter((r) => r.guardrail_passed === false).length,
        rows.filter((r) => r.model_used === null).length,
        rows.reduce((n, r) => n + (r.cost_cents ?? 0), 0),
        JSON.stringify(tally(rows.filter((r) => r.model_used), (r) => String(r.model_used))),
      ].join(" | "),
    );
  }
  const upstream = runs.filter((r) => r.error && /\b(401|403|429|5\d\d)\b|overload|rate.?limit|authentication|credit|billing|quota|invalid x-api-key/i.test(r.error));
  console.log(`runs whose error text names an upstream 401/403/429/5xx/quota: ${upstream.length}`);
  for (const [text, n] of Object.entries(tally(upstream, (r) => `${r.agent_name}: ${clip(r.error ?? "", 200)}`)).slice(0, 15)) {
    const sample = upstream.find((r) => `${r.agent_name}: ${clip(r.error ?? "", 200)}` === text);
    console.log(`  ×${n} [${sample?.started_at} run ${sample?.id}] ${text}`);
  }
  const otherErrors = runs.filter((r) => r.error && !upstream.includes(r));
  console.log(`other run errors: ${otherErrors.length}`);
  for (const [text, n] of Object.entries(tally(otherErrors, (r) => `${r.agent_name}: ${clip(r.error ?? "", 140)}`)).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ×${n} ${text}`);
  }
  const flagged = runs.filter((r) => r.guardrail_passed === false);
  console.log(`guardrail failures: ${flagged.length}`);
  for (const [text, n] of Object.entries(tally(flagged, (r) => `${r.agent_name}: ${clip((r.guardrail_notes ?? "(no notes)").replace(/\d+/g, "N"), 160)}`)).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ×${n} ${text}`);
  }
  const staleRunning = runs.filter((r) => r.status === "running" && r.started_at < hourAgo);
  console.log(`agent_runs still 'running' after 1 h: ${staleRunning.length}${staleRunning.length ? ` e.g. ${staleRunning.slice(0, 5).map((r) => `${r.agent_name}/${r.id}@${r.started_at}`).join(", ")}` : ""}`);

  console.log("\n== newest row per agent (all time) ==");
  const names = [...new Set((await all<{ agent_name: string }>((a, b) => db.from("agent_runs").select("agent_name").order("id").range(a, b))).map((r) => r.agent_name))].sort();
  for (const name of names) {
    const { data: row } = await db
      .from("agent_runs")
      .select("id, status, model_used, started_at, cost_cents")
      .eq("agent_name", name)
      .order("started_at", { ascending: false })
      .limit(1);
    const withModel = await db
      .from("agent_runs")
      .select("id, model_used, started_at, status")
      .eq("agent_name", name)
      .not("model_used", "is", null)
      .order("started_at", { ascending: false })
      .limit(1);
    const r = (row ?? [])[0] as { id: string; status: string; model_used: string | null; started_at: string } | undefined;
    const m = (withModel.data ?? [])[0] as { model_used: string; started_at: string; status: string } | undefined;
    console.log(`${name}: newest ${r?.started_at} ${r?.status} model=${r?.model_used ?? "null"} (run ${r?.id}); newest with a model: ${m ? `${m.started_at} ${m.model_used} ${m.status}` : "never"}`);
  }

  console.log("\n== workspace_config (empty field names only) ==");
  const cfg = await db.from("workspace_config").select("*");
  const fields: [string, string][] = [
    ["offer", "your_offer"], ["location", "user_location"], ["industry", "target_industry"],
    ["traits", "ideal_website_traits"], ["brand", "user_brand"], ["tone", "sales_tone"],
  ];
  for (const row of (cfg.data ?? []) as Record<string, string | null>[]) {
    const empty = fields.filter(([, col]) => !row[col] || String(row[col]).trim() === "").map(([label]) => label);
    console.log(`workspace ${row.workspace_id}: empty = ${empty.join(", ") || "none"}; updated_at=${row.updated_at}`);
  }

  console.log("\n== usage_events, last 30 days ==");
  const since30 = new Date(now - 30 * 24 * HOUR_MS).toISOString();
  const usage = await all<{ event_type: string; cost_cents: number | null; metadata: Record<string, unknown> | null; created_at: string }>(
    (a, b) => db.from("usage_events").select("event_type, cost_cents, metadata, created_at").gte("created_at", since30).order("created_at").range(a, b),
  );
  const groups = new Map<string, { n: number; cents: number; last: string; modes: Set<string> }>();
  for (const u of usage) {
    const key = `${u.event_type} / ${String(u.metadata?.endpoint ?? u.metadata?.agent ?? u.metadata?.strategy ?? "-")}`;
    const g = groups.get(key) ?? { n: 0, cents: 0, last: "", modes: new Set<string>() };
    g.n += 1;
    g.cents += u.cost_cents ?? 0;
    g.last = u.created_at;
    g.modes.add(String(u.metadata?.mode ?? "-"));
    groups.set(key, g);
  }
  console.log(`rows: ${usage.length}; total cost_cents: ${usage.reduce((n, u) => n + (u.cost_cents ?? 0), 0)}; metadata keys seen: ${[...new Set(usage.flatMap((u) => Object.keys(u.metadata ?? {})))].join(",")}`);
  console.log("event_type / endpoint | events | cost_cents | modes | last");
  for (const [key, g] of [...groups.entries()].sort()) console.log(`${key} | ${g.n} | ${g.cents} | ${[...g.modes].join(",")} | ${g.last}`);
  // One Place Details call is paid once per business; more rows than that for
  // one business (or a details row a Scout listener logged, with no
  // business_id) is the shared-listener double count.
  const details = usage.filter((u) => u.event_type === "places_call" && u.metadata?.endpoint === "details");
  const perBusiness = tally(details.filter((u) => u.metadata?.business_id), (u) => String(u.metadata?.business_id));
  const repeats = Object.entries(perBusiness).filter(([, n]) => n > 1);
  console.log(`details rows: ${details.length}; distinct businesses: ${Object.keys(perBusiness).length}; businesses with > 1 details row: ${repeats.length}${repeats.length ? ` (max ${Math.max(...repeats.map(([, n]) => n))}, e.g. ${repeats[0][0]})` : ""}; details rows with no business_id: ${details.filter((u) => !u.metadata?.business_id).length}`);
  const runs30 = runs.filter((r) => r.started_at >= since30);
  console.log(`agent_runs cost_cents, last 30 days: ${runs30.reduce((n, r) => n + (r.cost_cents ?? 0), 0)} over ${runs30.length} runs`);
}

const mode = process.argv[2];
const main = mode === "keys" ? keys : mode === "data" ? data : null;
if (!main) {
  console.error("usage: npx tsx scripts/audit3-probe.ts <keys|data>");
  process.exit(2);
}
main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
