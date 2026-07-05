/**
 * Design before/after screenshots (Sprint 4 acceptance).
 *
 * Drives the OFFLINE preview stack (memory-store worker + unconfigured web)
 * with puppeteer-core on the locally installed Chrome, so no auth tokens are
 * involved and no external API quota can be spent. Saves PNGs to docs/design/.
 *
 * Usage (PowerShell):
 *   node scripts/design-shots.mjs <prefix> <baseUrl>
 *   e.g. node scripts/design-shots.mjs before http://localhost:5175
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const prefix = process.argv[2] ?? "shot";
const baseUrl = process.argv[3] ?? "http://localhost:5175";
const outDir = path.resolve("docs/design");

const WIDTHS = [1280, 1600];

async function main() {
  await mkdir(outDir, { recursive: true });
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
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === l,
      );
      if (!btn) throw new Error(`nav button not found: ${l}`);
      btn.click();
    }, label);
    await new Promise((r) => setTimeout(r, 700));
  };
  const shot = async (name, width = 1280) => {
    await page.setViewport({ width, height: 900 });
    await new Promise((r) => setTimeout(r, 400));
    const file = path.join(outDir, `${prefix}-${name}-${width}.png`);
    await page.screenshot({ path: file });
    console.log("saved", file);
  };

  // Pipeline (default view)
  await shot("pipeline");

  // New Search form
  await clickNav("New Search");
  await shot("new-search");

  // Run a fixture search end-to-end, then the results table
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="83686"]');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "83686");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    const run = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Run search"),
    );
    run.click();
  });
  // Wait until the search settles (status chip reads "completed")
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("span")].some(
        (s) => s.textContent.trim().toLowerCase() === "completed",
      ),
    { timeout: 90_000, polling: 1000 },
  );
  await new Promise((r) => setTimeout(r, 800));
  // Expand the first expandable row so the issues list is visible
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll("tbody tr")].find(
      (r) => r.title && r.title.toLowerCase().includes("issue"),
    );
    if (tr) tr.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  for (const w of WIDTHS) await shot("live-search", w);

  // Agents view (placeholder shell)
  await clickNav("Agents");
  await shot("agents");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
