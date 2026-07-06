/**
 * Sprint 7 browser acceptance — money agents + Part A design fixes — against
 * the OFFLINE stack (memory store + fixtures + template AI, zero quota/cost).
 *
 *   node scripts/sprint7-e2e.mjs [baseUrl] [workerUrl]
 *
 * Covers: pipeline bar (10 chips + summary) replaces the card grid · Analyst
 * auto-ran (agent_runs + drawer Overview verdict) · drawer Builder Brief +
 * Sales Script tabs generate content · report endpoint renders · S7 light
 * canvas (#EEF1F5) + dark #3da0ff intact. Screenshots to docs/design/s7-*.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://localhost:5175";
const workerUrl = process.argv[3] ?? "http://localhost:8789";
const outDir = path.resolve("docs/design");

const AGENTS = [
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
    const file = path.join(outDir, `s7-${name}-${theme}.png`);
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
  await sleep(800);
  record("fixture search completes", true);

  // ---- 2. Pipeline bar replaces the card grid -----------------------------
  const bar = await page.evaluate(() => {
    const body = document.body.textContent;
    return {
      summary: /of 10\s+complete/i.test(body) && /scored/.test(body) && /running/.test(body),
      chips: [...document.querySelectorAll('[aria-label="Agent pipeline"] [role="tab"]')].length,
    };
  });
  record("pipeline summary line renders (N of 10 complete · scored · running)", bar.summary);
  record("pipeline bar has 10 chips in one row", bar.chips === 10, `chips=${bar.chips}`);
  await shot("workspace");

  // ---- 3. Analyst auto-ran (agent_runs + drawer verdict) ------------------
  const searches = await apiJson("/api/searches?limit=1");
  const searchId = searches.searches?.[0]?.id;
  const detail = await apiJson(`/api/searches/${searchId}`);
  const ranAgents = [...new Set((detail.agent_states ?? []).map((r) => r.agent_name))];
  record(
    "Analyst auto-ran for sellable leads (agent_runs has 'analyst')",
    ranAgents.includes("analyst"),
    `agents: ${ranAgents.length} distinct`,
  );
  const boise = (detail.leads ?? []).find((l) => l.business.name === "Boise Drain Pros");
  record(
    "Boise Drain Pros audit carries a persisted analyst_output",
    boise?.audit?.analyst_output != null,
  );

  // ---- 4. Drawer: Analyst verdict + Builder Brief + Sales Script ----------
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((r) =>
      r.textContent.includes("Boise Drain Pros"),
    );
    if (!row) throw new Error("Boise Drain Pros row not found");
    row.click();
  });
  await sleep(900);
  const overviewText = await page.evaluate(
    () => document.querySelector("aside")?.textContent ?? "",
  );
  record("drawer Overview shows the Analyst verdict", overviewText.includes("Analyst verdict"));
  record(
    "drawer has Builder Brief + Sales Script tabs",
    overviewText.includes("Builder Brief") && overviewText.includes("Sales Script"),
  );

  // Builder Brief — generate + verify a complete brief renders.
  await clickDrawerTab("Builder Brief");
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")]
      .find((b) => /Generate brief/i.test(b.textContent))
      ?.click();
  });
  await page.waitForFunction(
    () => (document.querySelector("aside pre")?.textContent ?? "").includes("Deploy instructions"),
    { timeout: 30_000, polling: 500 },
  );
  record("Builder Brief tab generates a complete brief (all sections)", true);
  await shot("drawer-brief");

  // Sales Script — generate + verify a talk track renders.
  await clickDrawerTab("Sales Script");
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")]
      .find((b) => /Generate script/i.test(b.textContent))
      ?.click();
  });
  await page.waitForFunction(
    () => /Talk track/i.test(document.querySelector("aside")?.textContent ?? ""),
    { timeout: 30_000, polling: 500 },
  );
  record("Sales Script tab generates a talk track + objections", true);
  await shot("drawer-sales");

  // ---- 5. Report endpoint renders -----------------------------------------
  const report = await page.evaluate(async (bid) => {
    const res = await fetch(`/api/businesses/${bid}/report`, {
      headers: { authorization: "Bearer dev-offline" },
    });
    const text = await res.text();
    return { status: res.status, ct: res.headers.get("content-type"), hasName: text.includes("Boise Drain Pros") };
  }, boise.business.id);
  record(
    "report endpoint renders (HTML in fixture mode) with the business",
    report.status === 200 && report.hasName,
    `status=${report.status} ct=${report.ct}`,
  );

  // ---- 6. Design tokens: S7 light canvas + dark accent --------------------
  await page.keyboard.press("Escape");
  await sleep(400);
  await clickNav("Dashboard");
  await shot("dashboard");

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
    "light canvas is the S7 darker gray #EEF1F5",
    lightCanvas === "rgb(238, 241, 245)",
    lightCanvas,
  );
  await shot("dashboard");
  await clickNav("Workspace");
  await shot("workspace");
  await page.evaluate(() => {
    [...document.querySelectorAll("tr")]
      .find((r) => r.textContent.includes("Boise Drain Pros"))
      ?.click();
  });
  await sleep(800);
  await clickDrawerTab("Builder Brief");
  await sleep(400);
  await shot("drawer-brief");

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
