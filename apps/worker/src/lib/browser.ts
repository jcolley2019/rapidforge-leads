/**
 * Shared Puppeteer browser (RFL.QUEUE.8): one Chrome per worker process,
 * launched lazily, pages gated by a semaphore of 2.
 *
 * RFL.QUEUE.8a — OFF BY DEFAULT and loop-safe. Unless SCREENSHOTS_ENABLED=
 * true nothing here imports puppeteer-core or touches a Chrome binary; every
 * caller gets BrowserUnavailableError("screenshots disabled"). When on:
 *
 *   - puppeteer-core is loaded once at boot (preloadBrowserModule), never
 *     inside a job: on Node 24 + tsx the first `import("puppeteer-core")`
 *     loads the whole module graph SYNCHRONOUSLY on the main thread, where
 *     no budget timer can interrupt it.
 *   - The executable is found with async fs (a slow drive stalls a threadpool
 *     thread, never the event loop) and passed as `executablePath`. The
 *     `channel` option is never used: puppeteer resolves it with accessSync
 *     over every candidate path (and execSync on Linux).
 *     Order: PUPPETEER_EXECUTABLE_PATH (if set, the only candidate) → bundled
 *     Chrome for Testing in puppeteer's cache → Playwright Chromium → the
 *     system Chrome that channel "chrome" would pick.
 *   - Resolution + launch run under ONE real 20s setTimeout budget; its abort
 *     kills the spawned process, and a launch that lands late is closed.
 *   - A failure is logged once, remembered for LAUNCH_RETRY_AFTER_MS, and
 *     callers get BrowserUnavailableError(reason) at once instead of waiting.
 *   - The page semaphore is only taken once a browser exists, never across a
 *     pending launch; an overrun page releases its slot immediately.
 */
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { StageTimeoutError, withBudget } from "./budget";
import { screenshotsEnabled } from "./env";

type Puppeteer = typeof import("puppeteer-core");
type Browser = Awaited<ReturnType<Puppeteer["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

export const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;
export const BROWSER_PAGE_SLOTS = 2;
/** After a failed/timed-out launch, callers degrade at once for this long. */
export const LAUNCH_RETRY_AFTER_MS = 10 * 60_000;

/**
 * RFL.VERIFY.3 V2: Chrome 150's HTTPS Upgrades / HTTPS-First handling turns
 * an http:// navigation into net::ERR_BLOCKED_BY_CLIENT — and no-SSL legacy
 * pages are the ones that most need the vision Design pass. Checked against
 * http://www.accurbore.com/ on the bundled Chrome 150.0.7871.24: blocked
 * with none of these features disabled, HTTP 200 with them.
 */
export const LAUNCH_ARGS: readonly string[] = [
  "--hide-scrollbars",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-features=HttpsUpgrades,HttpsFirstBalancedMode,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites",
];

/** No browser for this request; `reason` is short enough for an issue label. */
export class BrowserUnavailableError extends Error {
  override readonly name = "BrowserUnavailableError";
  constructor(readonly reason: string) {
    super(`browser unavailable: ${reason}`);
  }
}

/** Every launch attempt failed: short `reason` for issues, `detail` for the log. */
class LaunchFailure extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(reason);
  }
}

function firstLine(err: unknown, max = 80): string {
  const text = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// -- module load ---------------------------------------------------------------

let modulePromise: Promise<Puppeteer> | null = null;

function loadPuppeteer(): Promise<Puppeteer> {
  if (!modulePromise) {
    const t0 = performance.now();
    const pending = import("puppeteer-core");
    // Under Node 24 + tsx the import() call itself does the graph load.
    const blockedMs = Math.round(performance.now() - t0);
    modulePromise = pending.then(
      (mod) => {
        console.log(
          `[browser] puppeteer-core loaded in ${Math.round(performance.now() - t0)}ms (event loop blocked ${blockedMs}ms during import)`,
        );
        return mod;
      },
      (err: unknown) => {
        modulePromise = null;
        throw new LaunchFailure("puppeteer-core unavailable", firstLine(err, 200));
      },
    );
  }
  return modulePromise;
}

/**
 * Boot-time load of puppeteer-core when screenshots are on, so a slow or
 * synchronous module load happens before the poller claims jobs, never
 * inside a job's screenshot stage. No-op when screenshots are off.
 */
export async function preloadBrowserModule(): Promise<void> {
  if (!screenshotsEnabled()) return;
  console.log("[browser] SCREENSHOTS_ENABLED=true — loading puppeteer-core at boot");
  try {
    await loadPuppeteer();
  } catch (err) {
    console.warn(
      `[browser] ${err instanceof LaunchFailure ? `${err.reason}: ${err.detail}` : firstLine(err, 200)}`,
    );
  }
}

// -- executable resolution -------------------------------------------------------

export interface BrowserExecutable {
  label: string;
  path: string;
  /** chrome-headless-shell binaries launch with headless: "shell". */
  headlessShell: boolean;
}

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  /** Async existence check — never a *Sync call on the event loop. */
  exists(path: string): Promise<boolean>;
  /** Directory entries, [] when missing. */
  listDir(path: string): Promise<string[]>;
}

function defaultResolveDeps(): ResolveDeps {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    exists: async (path) => {
      try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
  };
}

/** "<platform>-<buildId>" / "chromium-<rev>" entries, newest build first. */
function newestFirst(entries: string[]): string[] {
  const key = (entry: string) =>
    entry
      .slice(entry.indexOf("-") + 1)
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  return [...entries].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

type Join = (...parts: string[]) => string;

/** puppeteer's cache folder suffix for this OS (chrome-<folder>/...). */
function cftFolder(platform: NodeJS.Platform, arch: string): string {
  if (platform === "win32") return arch === "ia32" ? "win32" : "win64";
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  return "linux64";
}

function cftRelative(join: Join, platform: NodeJS.Platform, arch: string, shell: boolean): string {
  const folder = cftFolder(platform, arch);
  if (shell) {
    return join(
      `chrome-headless-shell-${folder}`,
      platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
    );
  }
  if (platform === "win32") return join(`chrome-${folder}`, "chrome.exe");
  if (platform === "darwin") {
    return join(
      `chrome-${folder}`,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
  }
  return join("chrome-linux64", "chrome");
}

function playwrightRelatives(join: Join, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [join("chrome-win", "chrome.exe"), join("chrome-win64", "chrome.exe")];
  if (platform === "darwin") return [join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")];
  return [join("chrome-linux", "chrome"), join("chrome-linux64", "chrome")];
}

/** The paths channel "chrome" would check — minus puppeteer's D:\ guesses. */
function systemChromePaths(join: Join, deps: ResolveDeps): string[] {
  if (deps.platform === "win32") {
    const prefixes = new Set(
      [
        deps.env.PROGRAMFILES,
        deps.env.ProgramW6432,
        deps.env["ProgramFiles(x86)"],
        deps.env.LOCALAPPDATA,
        "C:\\Program Files",
        "C:\\Program Files (x86)",
      ].filter((p): p is string => Boolean(p)),
    );
    return [...prefixes].map((p) => join(p, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (deps.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return ["/opt/google/chrome/chrome"];
}

/**
 * Every launchable Chrome/Chromium on this machine, in launch-preference
 * order, found with async fs only. `reason` explains an empty list.
 */
export async function findBrowserExecutables(
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<{ found: BrowserExecutable[]; reason: string | null }> {
  // The target OS's separators (Windows layouts stay testable on Linux).
  const join: Join = deps.platform === "win32" ? win32.join : posix.join;
  const explicit = deps.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) {
    return (await deps.exists(explicit))
      ? { found: [{ label: `PUPPETEER_EXECUTABLE_PATH ${explicit}`, path: explicit, headlessShell: false }], reason: null }
      : { found: [], reason: "PUPPETEER_EXECUTABLE_PATH not found" };
  }
  const found: BrowserExecutable[] = [];
  const consider = async (label: string, path: string, headlessShell = false) => {
    if (found.some((f) => f.path === path)) return;
    if (await deps.exists(path)) found.push({ label, path, headlessShell });
  };

  // 1. Bundled Chrome for Testing (puppeteer's own download / `npx
  //    @puppeteer/browsers install chrome@stable`): <cache>/chrome/<plat>-<build>/…
  const cacheDir = deps.env.PUPPETEER_CACHE_DIR ?? join(deps.home, ".cache", "puppeteer");
  for (const [browser, shell] of [
    ["chrome", false],
    ["chrome-headless-shell", true],
  ] as const) {
    const root = join(cacheDir, browser);
    for (const entry of newestFirst(await deps.listDir(root))) {
      await consider(
        `bundled ${browser} ${entry}`,
        join(root, entry, cftRelative(join, deps.platform, deps.arch, shell)),
        shell,
      );
    }
  }

  // 2. Playwright's Chromium (what CI / the cloud container ships).
  const pwRoots = [
    deps.env.PLAYWRIGHT_BROWSERS_PATH,
    deps.platform === "win32" && deps.env.LOCALAPPDATA
      ? join(deps.env.LOCALAPPDATA, "ms-playwright")
      : join(deps.home, ".cache", "ms-playwright"),
    deps.platform === "linux" ? "/opt/pw-browsers" : undefined,
  ].filter((r): r is string => Boolean(r));
  for (const root of [...new Set(pwRoots)]) {
    const revisions = newestFirst((await deps.listDir(root)).filter((e) => /^chromium-\d+$/.test(e)));
    for (const rev of revisions) {
      for (const rel of playwrightRelatives(join, deps.platform)) {
        await consider(`playwright ${rev}`, join(root, rev, rel));
      }
    }
  }

  // 3. The installed Google Chrome.
  for (const path of systemChromePaths(join, deps)) {
    await consider(`system Chrome ${path}`, path);
  }

  return { found, reason: found.length === 0 ? "no Chrome/Chromium found" : null };
}

// -- launch ----------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;
let lastFailure: { reason: string; at: number } | null = null;

/** Resolve candidates and launch the first that starts, under `signal`. */
async function launchShared(signal: AbortSignal, attempt: { label: string }): Promise<Browser> {
  const puppeteer = await loadPuppeteer();
  attempt.label = "resolving executable";
  const { found, reason } = await findBrowserExecutables();
  if (found.length === 0) {
    throw new LaunchFailure(reason ?? "no Chrome/Chromium found", "set PUPPETEER_EXECUTABLE_PATH or install Chrome");
  }
  const failures: string[] = [];
  let lastError: unknown = "aborted";
  for (const exe of found) {
    if (signal.aborted) break;
    attempt.label = exe.label;
    try {
      const pending = puppeteer.launch({
        executablePath: exe.path,
        headless: exe.headlessShell ? "shell" : true,
        // A fresh copy per launch: puppeteer splices --disable-features out
        // of the array it is given (merging it into its own list), which
        // would silently drop the flag from every later relaunch.
        args: [...LAUNCH_ARGS],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        // Aborted only when the budget fires: puppeteer kills the spawn.
        signal,
      });
      // A launch that lands after the budget fired must not leak a Chrome.
      void pending.then(
        (late) => {
          if (signal.aborted) void late.close().catch(() => undefined);
        },
        () => undefined,
      );
      const browser = await pending;
      console.log(`[browser] launched (${exe.label})`);
      return browser;
    } catch (err) {
      lastError = err;
      failures.push(`${exe.label}: ${firstLine(err, 200)}`);
    }
  }
  throw new LaunchFailure(`launch failed: ${firstLine(lastError)}`, failures.join(" | "));
}

/**
 * The process-wide browser. Rejects with BrowserUnavailableError when
 * screenshots are disabled, the last launch failed < LAUNCH_RETRY_AFTER_MS
 * ago, or this launch fails / overruns BROWSER_LAUNCH_TIMEOUT_MS. Concurrent
 * callers share one pending launch, bounded by that one real timer.
 */
export function getSharedBrowser(): Promise<Browser> {
  if (!screenshotsEnabled()) {
    return Promise.reject(new BrowserUnavailableError("screenshots disabled"));
  }
  if (browserPromise) return browserPromise;
  if (lastFailure && Date.now() - lastFailure.at < LAUNCH_RETRY_AFTER_MS) {
    return Promise.reject(new BrowserUnavailableError(lastFailure.reason));
  }
  const attempt = { label: "loading puppeteer-core" };
  const mine: Promise<Browser> = withBudget("browser-launch", BROWSER_LAUNCH_TIMEOUT_MS, (signal) =>
    launchShared(signal, attempt),
  ).then(
    (browser) => {
      lastFailure = null;
      browser.on("disconnected", () => {
        console.warn("[browser] disconnected — will relaunch on next use");
        if (browserPromise === mine) browserPromise = null;
      });
      return browser;
    },
    (err: unknown) => {
      if (browserPromise === mine) browserPromise = null;
      const { reason, detail } =
        err instanceof StageTimeoutError
          ? { reason: `launch timed out after ${BROWSER_LAUNCH_TIMEOUT_MS / 1000}s`, detail: attempt.label }
          : err instanceof LaunchFailure
            ? { reason: err.reason, detail: err.detail }
            : { reason: `launch failed: ${firstLine(err)}`, detail: attempt.label };
      lastFailure = { reason, at: Date.now() };
      // The one log line per failed launch; callers in the retry window are silent.
      console.warn(
        `[browser] ${reason} (${detail}) — screenshots/PDF degrade; next launch attempt in ${Math.round(LAUNCH_RETRY_AFTER_MS / 60_000)} min`,
      );
      throw new BrowserUnavailableError(reason);
    },
  );
  browserPromise = mine;
  return mine;
}

/** Shutdown helper. */
export async function closeSharedBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  const b = await p?.catch(() => null);
  await b?.close().catch(() => undefined);
}

/** Tests: forget the browser, the module, the failure window and the slots. */
export async function resetSharedBrowser(): Promise<void> {
  await closeSharedBrowser();
  lastFailure = null;
  modulePromise = null;
  active = 0;
  waiters.length = 0;
}

// -- semaphore ----------------------------------------------------------------

let active = 0;
const waiters: Array<() => void> = [];

/** Take a page slot; a waiter leaves the queue if `signal` aborts first. */
async function acquire(signal: AbortSignal): Promise<() => void> {
  if (active < BROWSER_PAGE_SLOTS) {
    active += 1;
  } else {
    // release() hands its slot straight to the next waiter (no re-count).
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiters.indexOf(grant);
        if (i >= 0) waiters.splice(i, 1);
        reject(signal.reason);
      };
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
}

/** Pages currently open through withPage (for tests / health). */
export function browserPagesInUse(): number {
  return active;
}

/**
 * Run `fn` with a fresh page under the semaphore and a budget. Rejects with
 * BrowserUnavailableError when there is no browser (screenshots → issue,
 * PDF → HTML fallback), or StageTimeoutError on overrun. The slot is taken
 * only after the browser exists and is released the moment the budget fires.
 */
export async function withPage<T>(
  stage: string,
  budgetMs: number,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await getSharedBrowser();
  return withBudget(stage, budgetMs, async (signal) => {
    const release = await acquire(signal);
    let page: Page | null = null;
    const onAbort = () => {
      release();
      void (page as Page | null)?.close().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      page = await browser.newPage();
      if (signal.aborted) throw signal.reason; // overran while opening the page
      return await fn(page);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await (page as Page | null)?.close().catch(() => undefined);
      release();
    }
  });
}
