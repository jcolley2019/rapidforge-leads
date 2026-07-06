/**
 * Sprint 6 browser acceptance — screenshots pipeline + Design/Reputation/SEO
 * agents — against the OFFLINE stack (memory store + fixtures, zero quota).
 *
 *   node scripts/sprint6-e2e.mjs [baseUrl] [workerUrl]
 *
 * Covers: health reports the screenshot seam modes · fixture search runs all
 * TEN agents (agent_runs distinct set + agent cards in the workspace strip) ·
 * the dated-Wix lead's drawer gains design/SEO issues in "What's wrong" ·
 * Audit tab shows the three new groups · Screenshots tab renders BOTH
 * viewport images from the fixture pipeline · light AND dark screenshots to
 * docs/design/s6-*.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://localhost:5175";
const workerUrl = process.argv[3] ?? "http://localhost:8789";
const outDir = path.resolve("docs/design");

const AGENTS_EXPECTED = [
  "scout",
  "filter",
  "health",
  "conversion",
  "presence",
  "traffic",
  "design",
  "reputation",
  "seo",
  "scorer",
];

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

  // ---- 1. Health reports the Sprint 6 screenshot seam ----------------------
  record(
    "health reports screenshot capture/storage fixture modes",
    health.screenshot_capture_mode === "fixture" &&
      health.screenshot_storage_mode === "fixture-static",
    `capture=${health.screenshot_capture_mode} storage=${health.screenshot_storage_mode}`,
  );

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
    const file = path.join(outDir, `s6-${name}-${theme}.png`);
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

  // ---- 2. Run a fixture search --------------------------------------------
  await clickNav("New Search");
  await page.evaluate(() => {
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
    { timeout: 120_000, polling: 1000 },
  );
  await sleep(600);
  record("fixture search completes", true);

  // ---- 3. All TEN agents fired (agent_runs + workspace strip) -------------
  const searches = await apiJson("/api/searches?limit=1");
  const searchId = searches.searches?.[0]?.id;
  const detail = await apiJson(`/api/searches/${searchId}`);
  const ranAgents = [
    ...new Set((detail.agent_states ?? []).map((r) => r.agent_name)),
  ];
  const missing = AGENTS_EXPECTED.filter((a) => !ranAgents.includes(a));
  record(
    "all 10 agents wrote agent_runs for the search",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(",")}` : `${ranAgents.length} distinct`,
  );

  const stripText = await page.evaluate(() => document.body.textContent.toLowerCase());
  const missingCards = AGENTS_EXPECTED.filter((a) => !stripText.includes(a));
  record(
    "workspace agent strip shows all 10 agent cards",
    missingCards.length === 0,
    missingCards.length ? `missing: ${missingCards.join(",")}` : "",
  );
  await shot("workspace");

  // ---- 4. Dated-Wix drawer: new issues + audit groups + screenshots -------
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((r) =>
      r.textContent.includes("Boise Drain Pros"),
    );
    if (!row) throw new Error("Boise Drain Pros row not found");
    row.click();
  });
  await sleep(900);

  const overviewText = await page.evaluate(
    () => document.querySelector('[role="dialog"], aside')?.textContent ?? document.body.textContent,
  );
  record(
    'what\'s-wrong gains a Design bullet ("Site design…")',
    overviewText.includes("Site design"),
  );
  record(
    "what's-wrong gains SEO bullets (meta description / local targeting)",
    overviewText.includes("meta description") ||
      overviewText.includes("Weak local SEO targeting"),
  );

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

  await clickDrawerTab("Audit");
  const auditText = await page.evaluate(() => document.body.textContent);
  record(
    "Audit tab shows Design / Reputation / SEO groups",
    auditText.includes("Design — visual critique") &&
      auditText.includes("Reputation — Google signals") &&
      auditText.includes("SEO — on-page + local fit"),
  );
  // Expand the Design group so the evidence is visible in the screenshot.
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Design — visual critique"))
      ?.click();
  });
  await sleep(400);

  await clickDrawerTab("Screenshots");
  await sleep(800);
  const shots = await page.evaluate(() =>
    [...document.querySelectorAll("figure img")].map((img) => ({
      src: img.getAttribute("src"),
      loaded: img.complete && img.naturalWidth > 0,
    })),
  );
  record(
    "Screenshots tab renders BOTH viewports from the fixture pipeline",
    shots.length === 2 && shots.every((s) => s.loaded),
    shots.map((s) => `${s.src}:${s.loaded}`).join(" "),
  );
  record(
    "screenshot URLs come from the fixture-static store",
    shots.every((s) => s.src?.includes("/fixtures/screenshots/")),
  );
  await shot("drawer");

  // ---- 5. Dashboard + light-mode pass --------------------------------------
  await page.keyboard.press("Escape");
  await sleep(400);
  await clickNav("Dashboard");
  await shot("dashboard");

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("header button")].find(
      (b) => b.getAttribute("aria-label") === "Toggle theme",
    );
    btn?.click();
  });
  await sleep(500);
  const lightCanvas = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  record(
    "light mode canvas is the S6 neutral gray #f3f4f6",
    lightCanvas === "rgb(243, 244, 246)",
    lightCanvas,
  );
  const darkPrimaryCheck = await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    const probe = document.createElement("div");
    probe.style.color = "hsl(var(--primary))";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    document.documentElement.classList.remove("dark");
    return color;
  });
  record(
    "dark primary token is the brightened #3da0ff",
    darkPrimaryCheck === "rgb(61, 160, 255)",
    darkPrimaryCheck,
  );

  await shot("dashboard");
  await clickNav("Workspace");
  await shot("workspace");
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((r) =>
      r.textContent.includes("Boise Drain Pros"),
    );
    row?.click();
  });
  await sleep(800);
  await clickDrawerTab("Screenshots");
  await sleep(600);
  await shot("drawer");

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
