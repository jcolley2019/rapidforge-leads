/**
 * Sprint 5.5 browser acceptance — JoeyC rebrand + dedupe + dashboard —
 * against the OFFLINE stack (memory store + fixtures, zero quota).
 *
 *   node scripts/sprint55-e2e.mjs [baseUrl] [workerUrl]
 *
 * Covers: dashboard landing + KPIs matching store counts · dedupe chip
 * (N=2 across two fixture searches) in Leads + kanban · compact tables
 * with 1px dividers, phone/state single-line at 1280/1600 · kanban drag
 * persists on deduped cards · map placeholder (key blanked) · light AND
 * dark screenshots to docs/design/s5.5-*.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://localhost:5175";
const workerUrl = process.argv[3] ?? "http://localhost:8789";
const outDir = path.resolve("docs/design");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(outDir, { recursive: true });

  const health = await (await fetch(`${workerUrl}/health`)).json();
  if (health.store_mode !== "memory" || health.places_mode !== "fixture") {
    throw new Error(
      `worker on ${workerUrl} is not the offline stack (store=${health.store_mode}, places=${health.places_mode}) — aborting`,
    );
  }
  console.log("offline stack verified:", workerUrl);

  const browser = await puppeteer.launch({
    channel: "chrome",
    headless: "new",
    args: ["--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(baseUrl, { waitUntil: "networkidle0" });

  const clickNav = async (label) => {
    await page.evaluate((l) => {
      const btn = [...document.querySelectorAll("nav button")].find(
        (b) => b.textContent.trim() === l,
      );
      if (!btn) throw new Error(`nav button not found: ${l}`);
      btn.click();
    }, label);
    await sleep(700);
  };
  const shot = async (name) => {
    await sleep(350);
    const theme = await page.evaluate(() =>
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    );
    const file = path.join(outDir, `s5.5-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log("saved", file);
  };
  const apiJson = (p) =>
    page.evaluate(async (pp) => {
      const res = await fetch(pp, {
        headers: { authorization: "Bearer dev-offline" },
      });
      return res.json();
    }, p);
  const runSearch = async () => {
    await clickNav("New Search");
    await page.evaluate(() => {
      // Ensure the zip tab is active.
      const tab = [...document.querySelectorAll('button[role="tab"]')].find(
        (b) => b.textContent.trim() === "Zip / Radius",
      );
      tab?.click();
    });
    await sleep(300);
    await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="83686"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, "83686");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(250);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes("Run search"))
        .click();
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("span")].some(
          (s) => s.textContent.trim().toLowerCase() === "completed",
        ),
      { timeout: 90_000, polling: 1000 },
    );
    await sleep(600);
  };

  // ---- 1. Dashboard is the landing view; rebrand chrome present ----------
  const landing = await page.evaluate(() => ({
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()),
    groups: [...document.querySelectorAll("nav p")].map((p) =>
      p.textContent.trim().toUpperCase(),
    ),
    logotypeFont: getComputedStyle(
      [...document.querySelectorAll("header span")].find((s) =>
        s.textContent.includes("RapidForge"),
      ),
    ).fontFamily,
    bodyFont: getComputedStyle(document.body).fontFamily,
    canvas: getComputedStyle(document.body).backgroundColor,
  }));
  record(
    "dashboard is the default landing view",
    landing.h1.includes("Dashboard"),
  );
  record(
    "rail shows grouped micro-headers",
    ["PROSPECTING", "PIPELINE", "INTELLIGENCE", "ACCOUNT"].every((g) =>
      landing.groups.includes(g),
    ),
    landing.groups.join(","),
  );
  record(
    "brand typography active (Space Grotesk body, Orbitron logotype)",
    /Space Grotesk/i.test(landing.bodyFont) &&
      /Orbitron/i.test(landing.logotypeFont),
    `body=${landing.bodyFont.slice(0, 40)} logo=${landing.logotypeFont.slice(0, 30)}`,
  );
  record(
    "dark canvas is brand #0a0a0f",
    landing.canvas === "rgb(10, 10, 15)",
    landing.canvas,
  );

  // ---- 2. Two fixture searches (same zip → same businesses → dupes) ------
  await runSearch();
  await runSearch();
  await shot("workspace");

  // Nowrap at 1280 & 1600 on the (un-deduped) workspace table.
  for (const width of [1280, 1600]) {
    await page.setViewport({ width, height: 900 });
    await sleep(400);
    const metrics = await page.evaluate(() => {
      function lineCount(td) {
        const range = document.createRange();
        range.selectNodeContents(td);
        const rects = [...range.getClientRects()]
          .filter((r) => r.width > 1 && r.height > 4)
          .sort((a, b) => a.top - b.top);
        let lines = 0;
        let bottom = -Infinity;
        for (const r of rects) {
          if (r.top >= bottom - 2) {
            lines += 1;
            bottom = r.bottom;
          } else {
            bottom = Math.max(bottom, r.bottom);
          }
        }
        return Math.max(1, lines);
      }
      const rows = [...document.querySelectorAll("tbody tr[title]")];
      let phone = 0;
      let state = 0;
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells[2]) phone = Math.max(phone, lineCount(cells[2]));
        if (cells[7]) state = Math.max(state, lineCount(cells[7]));
      }
      const first = rows[0];
      return {
        phone,
        state,
        rowHeight: first ? first.getBoundingClientRect().height : 0,
        divider: first
          ? getComputedStyle(first).borderBottomWidth
          : "none",
        pageOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      };
    });
    record(
      `compact single-line table at ${width}`,
      metrics.phone === 1 &&
        metrics.state === 1 &&
        metrics.rowHeight > 0 &&
        metrics.rowHeight <= 56 &&
        metrics.divider === "1px" &&
        !metrics.pageOverflow,
      `phoneLines=${metrics.phone} stateLines=${metrics.state} rowH=${Math.round(metrics.rowHeight)}px divider=${metrics.divider}`,
    );
  }
  await page.setViewport({ width: 1280, height: 900 });

  // ---- 3. Dedupe in Leads: chip N=2, count matches distinct businesses ---
  const leadsData = await apiJson("/api/leads");
  const rawLeads = leadsData.leads;
  const distinct = new Set(rawLeads.map((l) => l.business.id)).size;

  await clickNav("Leads");
  await sleep(700);
  const leadsView = await page.evaluate(() => ({
    rows: document.querySelectorAll("tbody tr").length,
    chips: document.querySelectorAll('[title="Seen in 2 searches"]').length,
    shown: [...document.querySelectorAll("h1")]
      .map((h) => h.textContent)
      .join(" "),
  }));
  record(
    "Leads view dedupes to distinct businesses",
    leadsView.rows === distinct,
    `rows=${leadsView.rows} distinct=${distinct} (raw ${rawLeads.length})`,
  );
  record(
    "dedupe chip 'Seen in 2 searches' present",
    leadsView.chips > 0,
    `${leadsView.chips} chips`,
  );
  await shot("leads");

  // ---- 4. Kanban: deduped cards, chip, drag persists ----------------------
  await clickNav("Pipeline");
  await sleep(900);
  const kanbanBefore = await page.evaluate(() => ({
    cards: document.querySelectorAll('article[draggable="true"]').length,
    chips: document.querySelectorAll('[title="Seen in 2 searches"]').length,
  }));
  record(
    "kanban shows one card per business",
    kanbanBefore.cards === distinct,
    `cards=${kanbanBefore.cards} distinct=${distinct}`,
  );
  record("kanban cards carry the dedupe chip", kanbanBefore.chips > 0);

  const dragged = await page.evaluate(() => {
    const from = document.querySelector('section[aria-label="New column"]');
    const to = document.querySelector('section[aria-label="Called column"]');
    const card = from?.querySelector('article[draggable="true"]');
    if (!from || !to || !card) throw new Error("kanban columns/cards missing");
    const name = card.querySelector("p").textContent.trim();
    const dt = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    card.dispatchEvent(new DragEvent("dragstart", opts));
    to.dispatchEvent(new DragEvent("dragover", opts));
    to.dispatchEvent(new DragEvent("drop", opts));
    card.dispatchEvent(new DragEvent("dragend", opts));
    return name;
  });
  await sleep(1200);
  const afterDrag = await apiJson("/api/leads");
  const draggedRows = afterDrag.leads.filter(
    (l) => l.business.name === dragged,
  );
  record(
    "deduped drag persists status=called",
    draggedRows.some((l) => l.result.status === "called"),
    dragged,
  );
  await shot("kanban");

  // ---- 5. Dashboard KPIs match store counts -------------------------------
  await clickNav("Dashboard");
  await sleep(900);
  const searchesData = await apiJson("/api/searches?limit=50");
  const usage = await apiJson("/api/usage");

  // Recompute expectations exactly as the app defines them (deduped).
  const expected = await page.evaluate(
    ({ leads, searches, monthStart }) => {
      const groups = new Map();
      for (const lead of leads) {
        const list = groups.get(lead.business.id) ?? [];
        list.push(lead);
        groups.set(lead.business.id, list);
      }
      let hot = 0;
      let calls = 0;
      const beyond = new Set(["called", "interested", "sold"]);
      for (const group of groups.values()) {
        let audit = null;
        let rep = group[0];
        for (const l of group) {
          if (l.audit) {
            const stamp = l.audit.completed_at ?? l.audit.created_at ?? "";
            const cur = audit ? (audit.completed_at ?? audit.created_at ?? "") : "";
            if (!audit || stamp > cur) audit = l.audit;
          }
          const repWorked = rep.result.last_contacted_at !== null;
          const lWorked = l.result.last_contacted_at !== null;
          if (lWorked && !repWorked) rep = l;
          else if (lWorked && repWorked && (l.result.last_contacted_at ?? "") > (rep.result.last_contacted_at ?? "")) rep = l;
          else if (!lWorked && !repWorked && (l.result.created_at ?? "") > (rep.result.created_at ?? "")) rep = l;
        }
        if ((audit?.sellability_score ?? 0) >= 90) hot += 1;
        if (beyond.has(rep.result.status ?? "new")) calls += 1;
      }
      return {
        total: groups.size,
        hot,
        calls,
        month: searches.filter((s) => (s.created_at ?? "") >= monthStart).length,
      };
    },
    {
      leads: afterDrag.leads,
      searches: searchesData.searches,
      monthStart: new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ).toISOString(),
    },
  );

  const kpi = async (id) =>
    page.evaluate(
      (i) => document.querySelector(`[data-testid="${i}"]`)?.textContent ?? "",
      id,
    );
  const kpiTotal = await kpi("kpi-total-leads");
  const kpiHot = await kpi("kpi-hot-leads");
  const kpiMonth = await kpi("kpi-searches-month");
  const kpiCalls = await kpi("kpi-calls-made");
  const kpiSpend = await kpi("kpi-api-spend");
  record(
    "dashboard KPIs match store counts",
    Number(kpiTotal) === expected.total &&
      Number(kpiHot) === expected.hot &&
      Number(kpiMonth) === expected.month &&
      Number(kpiCalls) === expected.calls,
    `total ${kpiTotal}/${expected.total} hot ${kpiHot}/${expected.hot} month ${kpiMonth}/${expected.month} calls ${kpiCalls}/${expected.calls}`,
  );
  record(
    "spend KPI matches usage endpoint",
    kpiSpend === `$${(usage.total_cents / 100).toFixed(2)}`,
    `${kpiSpend} vs ${usage.total_cents}c`,
  );
  record(
    "recent searches listed",
    await page.evaluate(
      () => document.body.textContent.includes("Recent searches"),
    ),
  );
  await shot("dashboard");

  // ---- 6. Map tab placeholder (key blanked in this stack) -----------------
  await clickNav("New Search");
  await page.evaluate(() => {
    [...document.querySelectorAll('button[role="tab"]')]
      .find((b) => b.textContent.trim() === "Map")
      ?.click();
  });
  await sleep(500);
  record(
    "map tab graceful placeholder (no key in offline stack)",
    await page.evaluate(() =>
      document.body.textContent.includes("VITE_GOOGLE_MAPS_BROWSER_KEY"),
    ),
  );
  await shot("map");

  // ---- 7. Light mode: luxe canvas + the same five screenshots ------------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("header button")].find(
      (b) => b.getAttribute("aria-label") === "Toggle theme",
    );
    btn?.click();
  });
  await sleep(500);
  const luxe = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  record("light mode canvas is luxe #faf6f0", luxe === "rgb(250, 246, 240)", luxe);
  await shot("map");
  await clickNav("Dashboard");
  await shot("dashboard");
  await clickNav("Workspace");
  await shot("workspace");
  await clickNav("Leads");
  await shot("leads");
  await clickNav("Pipeline");
  await shot("kanban");

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} acceptance checks passed`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
