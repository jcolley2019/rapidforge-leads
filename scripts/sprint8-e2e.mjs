/**
 * Sprint 8 browser acceptance — UI polish + cost readout — against the
 * OFFLINE stack (memory store + fixtures + template AI, zero quota/cost).
 *
 *   node scripts/sprint8-e2e.mjs [baseUrl] [workerUrl]
 *
 * Covers: the old rounded pill row is GONE · the chip bar is the single
 * selector (11 tabs: All + 10 agents) · clicking an agent chip filters to its
 * feed and the active chip shows selected state · the All chip returns to the
 * results table · the drawer Audit tab shows the per-agent AI-cost readout ·
 * the light canvas renders exactly #EEF1F5. Screenshots to docs/design/s8-*.
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
      `worker on ${workerUrl} is not the offline stack (store=${health.store_mode}) — aborting`,
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
    const file = path.join(outDir, `s8-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log("saved", file);
  };
  const clickChip = async (matcher) => {
    await page.evaluate((m) => {
      const chip = [
        ...document.querySelectorAll('[aria-label="Agent pipeline"] [role="tab"]'),
      ].find((b) => b.textContent.trim().toLowerCase().startsWith(m));
      if (!chip) throw new Error(`chip not found: ${m}`);
      chip.click();
    }, matcher);
    await sleep(500);
  };
  const clickDrawerTab = async (label) => {
    await page.evaluate((l) => {
      const tabs = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent.trim() === l,
      );
      const tab = tabs[tabs.length - 1];
      if (!tab) throw new Error(`drawer tab not found: ${l}`);
      tab.click();
    }, label);
    await sleep(500);
  };

  // ---- 1. Run a fixture search --------------------------------------------
  await clickNav("New Search");
  await page.evaluate(() => {
    [...document.querySelectorAll('button[role="tab"]')]
      .find((b) => b.textContent.trim() === "Zip / Radius")
      ?.click();
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
    { timeout: 120_000, polling: 1000 },
  );
  await sleep(800);
  record("fixture search completes", true);

  // ---- 2. Pill row gone; chip bar is the single selector ------------------
  const selectors = await page.evaluate(() => ({
    pill: document.querySelector('[aria-label="Agents"]') !== null,
    chips: [...document.querySelectorAll('[aria-label="Agent pipeline"] [role="tab"]')].length,
  }));
  record("old rounded pill row is removed", selectors.pill === false);
  record(
    "chip bar has 11 tabs (All + 10 agents)",
    selectors.chips === 11,
    `tabs=${selectors.chips}`,
  );
  await shot("workspace");

  // ---- 3. Chip filters to an agent; All returns to the table --------------
  await clickChip("health");
  const afterHealth = await page.evaluate(() => ({
    active: [
      ...document.querySelectorAll(
        '[aria-label="Agent pipeline"] [role="tab"][aria-selected="true"]',
      ),
    ].some((b) => b.textContent.toLowerCase().includes("health")),
    agentDetail: document.body.textContent.includes("avg runtime"),
  }));
  record(
    "clicking a chip filters to that agent (active + feed shown)",
    afterHealth.active && afterHealth.agentDetail,
  );

  await clickChip("all");
  const afterAll = await page.evaluate(() => ({
    active: [
      ...document.querySelectorAll(
        '[aria-label="Agent pipeline"] [role="tab"][aria-selected="true"]',
      ),
    ].some((b) => b.textContent.trim() === "All"),
    table: !document.body.textContent.includes("avg runtime"),
  }));
  record(
    "All chip returns to the results table",
    afterAll.active && afterAll.table,
  );

  // ---- 4. Drawer Audit tab shows the cost readout -------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll("tr")]
      .find((r) => r.textContent.includes("Boise Drain Pros"))
      ?.click();
  });
  await sleep(900);
  await clickDrawerTab("Audit");
  const auditText = await page.evaluate(
    () => document.querySelector("aside")?.textContent ?? "",
  );
  record(
    "drawer Audit tab shows the per-agent AI-cost readout",
    auditText.includes("AI cost") && /this lead/.test(auditText),
  );
  await shot("drawer-cost");

  // ---- 5. Light canvas renders #EEF1F5 ------------------------------------
  await page.keyboard.press("Escape");
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll("header button")]
      .find((b) => b.getAttribute("aria-label") === "Toggle theme")
      ?.click();
  });
  await sleep(500);
  const lightCanvas = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  record(
    "light canvas renders the S7/S8 gray #EEF1F5",
    lightCanvas === "rgb(238, 241, 245)",
    lightCanvas,
  );
  await shot("workspace");
  await clickNav("Dashboard");
  await shot("dashboard");

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
