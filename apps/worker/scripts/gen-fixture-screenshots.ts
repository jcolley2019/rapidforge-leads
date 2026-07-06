/**
 * One-time generator for the committed fixture screenshots (Sprint 6).
 *
 * Renders every SITE_FIXTURES document (plus the generic fallback page)
 * in the locally installed Chrome at the real capture viewports and writes
 * {slug}-{desktop|mobile}.jpg pairs into apps/worker/fixtures/screenshots.
 * The FixtureScreenshotCapturer serves these at runtime, so CI and the
 * offline stack never need Chrome.
 *
 * Run from apps/worker:  npx tsx scripts/gen-fixture-screenshots.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import {
  DESKTOP_VIEWPORT,
  FIXTURE_SCREENSHOT_DIR,
  MOBILE_VIEWPORT,
  SCREENSHOT_JPEG_QUALITY,
  screenshotSlug,
} from "../src/lib/screenshots";
import { fallbackSiteFixture, SITE_FIXTURES } from "../src/lib/site-fixtures";

async function main(): Promise<void> {
  await mkdir(FIXTURE_SCREENSHOT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    channel: "chrome",
    headless: true,
    args: ["--hide-scrollbars", "--disable-gpu"],
  });
  try {
    const jobs: Array<[string, string]> = Object.entries(SITE_FIXTURES).map(
      ([host, fixture]) => [screenshotSlug(`https://${host}/`), fixture.html],
    );
    jobs.push(["fallback", fallbackSiteFixture("example-business.com").html]);

    for (const [slug, html] of jobs) {
      for (const [name, viewport] of [
        ["desktop", DESKTOP_VIEWPORT],
        ["mobile", MOBILE_VIEWPORT],
      ] as const) {
        const page = await browser.newPage();
        try {
          await page.setViewport({
            ...viewport,
            isMobile: name === "mobile",
            hasTouch: name === "mobile",
          });
          // domcontentloaded: fixture docs reference unreachable CDN assets
          // (wixstatic etc.) — waiting for network idle would stall on them.
          await page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          await new Promise((r) => setTimeout(r, 300));
          const data = await page.screenshot({
            type: "jpeg",
            quality: SCREENSHOT_JPEG_QUALITY,
          });
          const file = `${FIXTURE_SCREENSHOT_DIR}/${slug}-${name}.jpg`;
          await writeFile(file, Buffer.from(data));
          console.log(`wrote ${file} (${data.length} bytes)`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
