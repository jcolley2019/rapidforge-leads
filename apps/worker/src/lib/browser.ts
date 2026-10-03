/**
 * Shared Puppeteer browser (RFL.QUEUE.8): one Chrome per worker process,
 * launched lazily with a 20s launch budget, pages gated by a semaphore of 2.
 *
 * Executable resolution: PUPPETEER_EXECUTABLE_PATH → channel "chrome" →
 * a bundled/Playwright Chromium if present → null (callers degrade: no
 * screenshot, HTML report). A failed launch is logged, never thrown, and is
 * retried on the next request (the promise is not cached on failure).
 */
import { existsSync } from "node:fs";
import { withBudget } from "./budget";

type Puppeteer = typeof import("puppeteer-core");
type Browser = Awaited<ReturnType<Puppeteer["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

export const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;
export const BROWSER_PAGE_SLOTS = 2;

let browserPromise: Promise<Browser | null> | null = null;

/** Candidate Chromium binaries when channel "chrome" is unavailable. */
function bundledChromiumCandidates(): string[] {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    `${process.env.HOME ?? ""}/.cache/ms-playwright`,
  ].filter((r): r is string => Boolean(r));
  const out: string[] = [];
  for (const root of roots) {
    out.push(`${root}/chromium`, `${root}/chromium/chrome-linux/chrome`);
    for (const v of ["1194", "1193", "1200", "1180"]) {
      out.push(`${root}/chromium-${v}/chrome-linux/chrome`);
    }
  }
  return out;
}

async function launch(): Promise<Browser | null> {
  let puppeteer: Puppeteer;
  try {
    puppeteer = await import("puppeteer-core");
  } catch (err) {
    console.warn(
      `[browser] puppeteer-core unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const args = ["--hide-scrollbars", "--disable-gpu", "--no-sandbox"];
  const attempts: Array<{ label: string; opts: Record<string, unknown> }> = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    attempts.push({
      label: `executablePath ${process.env.PUPPETEER_EXECUTABLE_PATH}`,
      opts: { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH },
    });
  }
  attempts.push({ label: 'channel "chrome"', opts: { channel: "chrome" } });
  for (const candidate of bundledChromiumCandidates()) {
    if (existsSync(candidate)) {
      attempts.push({ label: `bundled ${candidate}`, opts: { executablePath: candidate } });
      break;
    }
  }
  for (const attempt of attempts) {
    try {
      const browser = await withBudget("browser-launch", BROWSER_LAUNCH_TIMEOUT_MS, () =>
        puppeteer.launch({ headless: true, args, ...attempt.opts }),
      );
      console.log(`[browser] launched (${attempt.label})`);
      browser.on("disconnected", () => {
        console.warn("[browser] disconnected — will relaunch on next use");
        browserPromise = null;
      });
      return browser;
    } catch (err) {
      console.warn(
        `[browser] launch via ${attempt.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.warn("[browser] no Chrome/Chromium available — browser stages degrade");
  return null;
}

/** The process-wide browser, or null when none can be launched. */
export function getSharedBrowser(): Promise<Browser | null> {
  if (!browserPromise) {
    browserPromise = launch().then((b) => {
      if (!b) browserPromise = null; // retry next time
      return b;
    });
  }
  return browserPromise;
}

/** Test/shutdown helper. */
export async function closeSharedBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  const b = await p?.catch(() => null);
  await b?.close().catch(() => undefined);
}

// -- semaphore ----------------------------------------------------------------

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<() => void> {
  if (active < BROWSER_PAGE_SLOTS) {
    active += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    waiters.shift()?.();
  };
}

/** Pages currently open through withPage (for tests / health). */
export function browserPagesInUse(): number {
  return active;
}

/**
 * Run `fn` with a fresh page under the semaphore and a budget. Returns null
 * when no browser is available; rethrows timeouts/errors so callers decide
 * (screenshots → null, PDF → HTML fallback).
 */
export async function withPage<T>(
  stage: string,
  budgetMs: number,
  fn: (page: Page) => Promise<T>,
): Promise<T | null> {
  const browser = await getSharedBrowser();
  if (!browser) return null;
  const release = await acquire();
  let page: Page | null = null;
  try {
    return await withBudget(stage, budgetMs, async () => {
      page = await browser.newPage();
      return fn(page);
    });
  } finally {
    await (page as Page | null)?.close().catch(() => undefined);
    release();
  }
}
