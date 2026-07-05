/**
 * Sprint 5 browser acceptance (kickoff E2E list) against the OFFLINE stack
 * (RAPIDFORGE_FORCE_MEMORY_STORE + RAPIDFORGE_FORCE_FIXTURES worker on 8789,
 * unconfigured web on 5175) — zero external quota, no auth tokens.
 *
 *   node scripts/sprint5-e2e.mjs [baseUrl] [workerUrl]
 *
 * Covers: search populates · kanban drag New→Called persists (store-verified
 * via /api/leads) · drawer note autosave survives reload · CSV export
 * contents · cmd-K view jump + jump-to-lead · phone/state nowrap at
 * 1280/1600 · usage meter renders · map tab graceful placeholder (the
 * pin-drop E2E itself is BLOCKED: no VITE_GOOGLE_MAPS_BROWSER_KEY).
 * Screenshots → docs/design/s5-*.png.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://localhost:5175";
const workerUrl = process.argv[3] ?? "http://localhost:8789";
const outDir = path.resolve("docs/design");
const NOTE_TEXT = `S5 acceptance note ${Date.now()}`;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(outDir, { recursive: true });

  // Safety gate: refuse to run against anything but the offline stack.
  const health = await (await fetch(`${workerUrl}/health`)).json();
  if (health.store_mode !== "memory" || health.places_mode !== "fixture") {
    throw new Error(
      `worker on ${workerUrl} is not the offline stack (store=${health.store_mode}, places=${health.places_mode}) — aborting`,
    );
  }
  console.log("offline stack verified:", workerUrl);

  const downloadDir = path.join(os.tmpdir(), `rf-s5-${Date.now()}`);
  await mkdir(downloadDir, { recursive: true });

  const browser = await puppeteer.launch({
    channel: "chrome",
    headless: "new",
    args: ["--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(baseUrl, { waitUntil: "networkidle0" });

  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  const clickNav = async (label) => {
    await page.evaluate((l) => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === l,
      );
      if (!btn) throw new Error(`nav button not found: ${l}`);
      btn.click();
    }, label);
    await sleep(700);
  };
  const shot = async (name, width = 1280) => {
    await page.setViewport({ width, height: 900 });
    await sleep(400);
    const file = path.join(outDir, `s5-${name}-${width}.png`);
    await page.screenshot({ path: file });
    console.log("saved", file);
    await page.setViewport({ width: 1280, height: 900 });
  };
  const apiLeads = () =>
    page.evaluate(async () => {
      const res = await fetch("/api/leads", {
        headers: { authorization: "Bearer dev-offline" },
      });
      return (await res.json()).leads;
    });

  // ---- 1. Map tab renders the graceful placeholder (key absent) ----------
  await clickNav("New Search");
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button[role="tab"]')].find(
      (b) => b.textContent.trim() === "Map",
    );
    if (!tab) throw new Error("Map tab not found");
    tab.click();
  });
  await sleep(500);
  const placeholderOk = await page.evaluate(() =>
    document.body.textContent.includes("VITE_GOOGLE_MAPS_BROWSER_KEY"),
  );
  record("map tab shows glass placeholder with setup instructions", placeholderOk);
  await shot("map", 1280);
  await shot("map", 1600);

  // ---- 2. Zip search populates results ------------------------------------
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button[role="tab"]')].find(
      (b) => b.textContent.trim() === "Zip / Radius",
    );
    tab.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="83686"]');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "83686");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);
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
  await sleep(800);
  const rowCount = await page.evaluate(
    () => document.querySelectorAll("tbody tr[title]").length,
  );
  record("search populates results", rowCount > 0, `${rowCount} rows`);

  // ---- 3. Nowrap at 1280 & 1600 -------------------------------------------
  for (const width of [1280, 1600]) {
    await page.setViewport({ width, height: 900 });
    await sleep(400);
    const metrics = await page.evaluate(() => {
      // Count rendered line boxes of the cell CONTENT (td height just
      // mirrors the tallest cell in the row — the 2-line Business cell).
      function lineCount(td) {
        const range = document.createRange();
        range.selectNodeContents(td);
        // Merge vertically-overlapping rects (a chip's border box and its
        // inner text run share a line but differ by the chip's padding).
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
      let maxPhoneLines = 0;
      let maxStateLines = 0;
      let overflow = 0;
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells[2]) maxPhoneLines = Math.max(maxPhoneLines, lineCount(cells[2]));
        if (cells[7]) maxStateLines = Math.max(maxStateLines, lineCount(cells[7]));
        for (const td of cells) {
          if (td.scrollWidth > td.clientWidth + 1) overflow += 1;
        }
      }
      return {
        maxPhoneLines,
        maxStateLines,
        overflow,
        pageOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      };
    });
    const ok =
      metrics.maxPhoneLines === 1 &&
      metrics.maxStateLines === 1 &&
      !metrics.pageOverflow;
    record(
      `phone/state single-line at ${width}`,
      ok,
      `phoneLines=${metrics.maxPhoneLines} stateLines=${metrics.maxStateLines} overflowCells=${metrics.overflow} pageHScroll=${metrics.pageOverflow}`,
    );
  }
  await page.setViewport({ width: 1280, height: 900 });

  // ---- 4. Drawer opens from a row; note autosaves; survives reload --------
  const firstBusiness = await page.evaluate(() => {
    const row = document.querySelector('tbody tr[title="Open lead detail"]');
    const name = row.querySelector("td:nth-child(2) div").textContent.trim();
    row.click();
    return name;
  });
  await sleep(700);
  const drawerOpen = await page.evaluate(
    () => !!document.querySelector('aside[role="dialog"]'),
  );
  record("row click opens lead drawer", drawerOpen, firstBusiness);
  await shot("drawer", 1280);
  await shot("drawer", 1600);

  await page.evaluate(() => {
    [...document.querySelectorAll('aside[role="dialog"] button')]
      .find((b) => b.textContent.trim() === "Notes")
      .click();
  });
  await sleep(300);
  await page.type('textarea[aria-label="Lead notes (auto-saved)"]', NOTE_TEXT, {
    delay: 5,
  });
  await sleep(1500); // debounce 700ms + save round-trip
  const savedShown = await page.evaluate(() =>
    document.querySelector('aside[role="dialog"]').textContent.includes("saved"),
  );
  record("notes autosave indicator shows saved", savedShown);

  await page.reload({ waitUntil: "networkidle0" });
  await sleep(600);
  await clickNav("Leads");
  await sleep(600);
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll("tbody tr")].find((r) =>
      r.textContent.includes(name),
    );
    if (!row) throw new Error(`lead row not found after reload: ${name}`);
    row.click();
  }, firstBusiness);
  await sleep(700);
  await page.evaluate(() => {
    [...document.querySelectorAll('aside[role="dialog"] button')]
      .find((b) => b.textContent.trim() === "Notes")
      .click();
  });
  await sleep(400);
  const persistedNote = await page.evaluate(
    () =>
      document.querySelector('textarea[aria-label="Lead notes (auto-saved)"]')
        ?.value ?? "",
  );
  record(
    "note persists across page reload",
    persistedNote.includes(NOTE_TEXT),
    persistedNote.slice(0, 60),
  );
  await page.keyboard.press("Escape");
  await sleep(400);

  // ---- 5. Kanban drag New→Called persists to the store --------------------
  await clickNav("Pipeline");
  await sleep(900);
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
  const inCalled = await page.evaluate((name) => {
    const col = document.querySelector('section[aria-label="Called column"]');
    return col.textContent.includes(name);
  }, dragged);
  record("kanban drag moves card New→Called", inCalled, dragged);

  const leadRows = await apiLeads();
  const draggedLead = leadRows.find((l) => l.business.name === dragged);
  record(
    "store persists status=called after drag",
    draggedLead?.result.status === "called",
    `${dragged} → ${draggedLead?.result.status}`,
  );
  record(
    "last_contacted_at stamped on status change",
    Boolean(draggedLead?.result.last_contacted_at),
    draggedLead?.result.last_contacted_at ?? "missing",
  );
  await shot("kanban", 1280);
  await shot("kanban", 1600);

  // ---- 6. CSV export contents ---------------------------------------------
  await clickNav("Leads");
  await sleep(700);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Export CSV"))
      .click();
  });
  let csvFile = null;
  for (let i = 0; i < 20 && !csvFile; i += 1) {
    await sleep(250);
    const files = await readdir(downloadDir);
    csvFile = files.find((f) => f.endsWith(".csv"));
  }
  if (!csvFile) {
    record("CSV downloads", false, "no file appeared");
  } else {
    const csv = await readFile(path.join(downloadDir, csvFile), "utf8");
    const lines = csv.trimEnd().split("\r\n");
    const headerOk = lines[0].startsWith("name,phone,address,website");
    const hasDragged = csv.includes(dragged) && csv.includes("called");
    const hasNote = csv.includes("S5 acceptance note");
    record(
      "CSV contents verified",
      headerOk && lines.length - 1 === leadRows.length && hasDragged && hasNote,
      `${csvFile}: ${lines.length - 1} rows (store has ${leadRows.length}); header=${headerOk}; called-status=${hasDragged}; note=${hasNote}`,
    );
  }

  // ---- 7. cmd-K: view jump + jump-to-lead ----------------------------------
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await sleep(500);
  const paletteOpen = await page.evaluate(
    () => !!document.querySelector("[cmdk-root]"),
  );
  record("Ctrl+K opens palette", paletteOpen);
  await shot("cmdk", 1280);
  await page.keyboard.type("Settings", { delay: 20 });
  await sleep(300);
  await page.keyboard.press("Enter");
  await sleep(700);
  const onSettings = await page.evaluate(() =>
    [...document.querySelectorAll("h1")].some(
      (h) => h.textContent.trim() === "Settings",
    ),
  );
  record("palette jumps to Settings view", onSettings);

  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await sleep(500);
  await page.keyboard.type(dragged.slice(0, 12), { delay: 20 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(700);
  const drawerFromPalette = await page.evaluate(
    (name) =>
      document
        .querySelector('aside[role="dialog"]')
        ?.textContent.includes(name) ?? false,
    dragged,
  );
  record("palette jumps to lead (opens drawer)", drawerFromPalette, dragged);
  await page.keyboard.press("Escape");

  // ---- 8. Usage meter renders a rollup ------------------------------------
  const meterText = await page.evaluate(
    () =>
      [...document.querySelectorAll("header button")]
        .map((b) => b.textContent.trim())
        .find((t) => t.includes("/ mo")) ?? "",
  );
  record("usage meter renders", /\$\d+\.\d{2} \/ mo/.test(meterText), meterText);

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
