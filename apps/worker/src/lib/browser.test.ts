/**
 * Shared browser hardening (RFL.QUEUE.8a) with puppeteer-core mocked: off by
 * default, a launch can never outlive its 20s real-timer budget, failures are
 * logged once and remembered, late launches are closed, and the page
 * semaphore is never held across a pending launch or an overrun.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pptr = vi.hoisted(() => ({ launch: vi.fn(), imports: 0 }));
vi.mock("puppeteer-core", () => {
  pptr.imports += 1;
  return { launch: pptr.launch, default: { launch: pptr.launch } };
});

import {
  BROWSER_LAUNCH_TIMEOUT_MS,
  BrowserUnavailableError,
  LAUNCH_ARGS,
  LAUNCH_RETRY_AFTER_MS,
  browserPagesInUse,
  findBrowserExecutables,
  getSharedBrowser,
  preloadBrowserModule,
  resetSharedBrowser,
  withPage,
  type ResolveDeps,
} from "./browser";
import { StageTimeoutError } from "./budget";

/** Captured before any test fakes timers: a REAL timer to yield to I/O. */
const realSetTimeout = globalThis.setTimeout;

/** Advance fake time in chunks — for phases with no real I/O pending. */
async function advance(ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await new Promise((r) => realSetTimeout(r, 1));
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
  }
}

/**
 * While real I/O is in flight (the async executable check), creep fake time
 * forward in 10ms steps with real 2ms yields until `cond` holds — fake time
 * can never outrun the I/O into a budget.
 */
async function until(cond: () => boolean, maxFakeMs = 2_000): Promise<void> {
  for (let t = 0; t < maxFakeMs && !cond(); t += 10) {
    await new Promise((r) => realSetTimeout(r, 2));
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(cond()).toBe(true);
}

/** Track a promise's settlement without unhandled rejections. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

function fakeBrowser() {
  const pages: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  return {
    pages,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => {
      const page = { close: vi.fn(async () => undefined) };
      pages.push(page);
      return page;
    }),
  };
}

const saved = {
  enabled: process.env.SCREENSHOTS_ENABLED,
  exe: process.env.PUPPETEER_EXECUTABLE_PATH,
};

beforeEach(async () => {
  await resetSharedBrowser();
  pptr.launch.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  process.env.SCREENSHOTS_ENABLED = "true";
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath; // exists on every machine
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [key, value] of [
    ["SCREENSHOTS_ENABLED", saved.enabled],
    ["PUPPETEER_EXECUTABLE_PATH", saved.exe],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const warnLines = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

describe("off by default", () => {
  // Keep first: proves puppeteer-core is never even imported when off.
  it("SCREENSHOTS_ENABLED unset → 'screenshots disabled', puppeteer-core never imported or launched", async () => {
    delete process.env.SCREENSHOTS_ENABLED;
    await preloadBrowserModule(); // no-op when off
    const err = await withPage("screenshot-desktop", 30_000, async () => "never").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as BrowserUnavailableError).reason).toBe("screenshots disabled");
    expect(pptr.imports).toBe(0);
    expect(pptr.launch).not.toHaveBeenCalled();
  });
});

describe("launch budget (real timer)", () => {
  it("a never-resolving launch rejects at 20s, aborts the spawn, holds no page slot, logs once", async () => {
    let launchSignal: AbortSignal | undefined;
    pptr.launch.mockImplementation((opts: { signal?: AbortSignal }) => {
      launchSignal = opts.signal;
      return new Promise<never>(() => undefined);
    });
    const t0 = Date.now();
    const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => pptr.launch.mock.calls.length === 1);

    await advance(10_000);
    expect(state.settled).toBe(false);
    expect(browserPagesInUse()).toBe(0); // no slot taken across the pending launch

    await advance(BROWSER_LAUNCH_TIMEOUT_MS - 10_000);
    expect(state.settled).toBe(true);
    expect(Date.now() - t0).toBeLessThanOrEqual(BROWSER_LAUNCH_TIMEOUT_MS + 1_000);
    expect(state.error).toBeInstanceOf(BrowserUnavailableError);
    expect((state.error as BrowserUnavailableError).reason).toBe("launch timed out after 20s");
    expect(launchSignal?.aborted).toBe(true); // puppeteer kills the spawned process on abort
    const launchLogs = warnLines().filter((l) => l.startsWith("[browser] launch timed out"));
    expect(launchLogs).toHaveLength(1);
    expect(launchLogs[0]).toContain("PUPPETEER_EXECUTABLE_PATH");
  });

  it("the failure is remembered: callers in the retry window degrade at once, silently; then it relaunches", async () => {
    pptr.launch.mockImplementation(() => new Promise<never>(() => undefined));
    const first = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => pptr.launch.mock.calls.length === 1);
    await advance(BROWSER_LAUNCH_TIMEOUT_MS);
    expect(first.error).toBeInstanceOf(BrowserUnavailableError);

    const second = await withPage("screenshot-mobile", 30_000, async () => "shot").catch((e: unknown) => e);
    expect((second as BrowserUnavailableError).reason).toBe("launch timed out after 20s");
    expect(pptr.launch).toHaveBeenCalledTimes(1); // no relaunch
    expect(warnLines().filter((l) => l.startsWith("[browser]"))).toHaveLength(1); // logged once

    const browser = fakeBrowser();
    pptr.launch.mockResolvedValue(browser);
    vi.setSystemTime(Date.now() + LAUNCH_RETRY_AFTER_MS);
    const third = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => third.settled);
    expect(third.value).toBe("shot");
    expect(pptr.launch).toHaveBeenCalledTimes(2);
  });

  it("a launch that lands after the budget fired is closed (no orphan Chrome)", async () => {
    const late = fakeBrowser();
    let land!: (b: typeof late) => void;
    pptr.launch.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => pptr.launch.mock.calls.length === 1);
    await advance(BROWSER_LAUNCH_TIMEOUT_MS);
    expect(state.error).toBeInstanceOf(BrowserUnavailableError);
    land(late);
    await advance(500);
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it("a launch that throws synchronously rejects at once with the reason and leaves no timer", async () => {
    pptr.launch.mockImplementation(() => {
      throw new Error("spawn UNKNOWN");
    });
    const t0 = Date.now();
    const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => state.settled);
    expect(Date.now() - t0).toBeLessThan(1_000); // nowhere near the 20s budget
    expect((state.error as BrowserUnavailableError).reason).toBe("launch failed: spawn UNKNOWN");
    expect(vi.getTimerCount()).toBe(0);
    expect(warnLines().filter((l) => l.startsWith("[browser] launch failed"))).toHaveLength(1);
  });

  it("a missing PUPPETEER_EXECUTABLE_PATH is reported without launching", async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/nope/chrome-does-not-exist";
    const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => state.settled);
    expect((state.error as BrowserUnavailableError).reason).toBe("PUPPETEER_EXECUTABLE_PATH not found");
    expect(pptr.launch).not.toHaveBeenCalled();
  });

  it("launches with the resolved executablePath, never `channel`", async () => {
    pptr.launch.mockResolvedValue(fakeBrowser());
    const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
    await until(() => state.settled);
    expect(state.value).toBe("shot");
    const opts = pptr.launch.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.executablePath).toBe(process.execPath);
    expect(opts).not.toHaveProperty("channel");
    expect(opts.headless).toBe(true);
    expect(opts.timeout).toBe(BROWSER_LAUNCH_TIMEOUT_MS);
  });

  it("every launch disables Chrome's HTTPS upgrades, even after puppeteer splices the flag out (RFL.VERIFY.3 V2)", async () => {
    const HTTPS_FLAG =
      "--disable-features=HttpsUpgrades,HttpsFirstBalancedMode,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites";
    expect(LAUNCH_ARGS).toContain(HTTPS_FLAG);
    const seen: string[][] = [];
    pptr.launch.mockImplementation(async (opts: { args: string[] }) => {
      seen.push([...opts.args]);
      // What puppeteer 25 does: merge the caller's --disable-features into
      // its own list and remove it from the caller's array in place.
      const i = opts.args.findIndex((a) => a.startsWith("--disable-features="));
      if (i >= 0) opts.args.splice(i, 1);
      return fakeBrowser();
    });
    for (let n = 0; n < 2; n += 1) {
      const state = track(withPage("screenshot-desktop", 30_000, async () => "shot"));
      await until(() => state.settled);
      expect(state.value).toBe("shot");
      await resetSharedBrowser(); // the next call relaunches
    }
    expect(seen).toHaveLength(2);
    for (const args of seen) expect(args).toContain(HTTPS_FLAG);
    expect(LAUNCH_ARGS).toContain(HTTPS_FLAG);
  });
});

describe("page semaphore", () => {
  it("an overrun page frees its slot at the budget; a waiter whose budget fires leaves the queue", async () => {
    const browser = fakeBrowser();
    pptr.launch.mockResolvedValue(browser);
    const warm = track(getSharedBrowser()); // launch first: the rest is pure timers
    await until(() => warm.settled);
    const hang = () => new Promise<never>(() => undefined);
    const a = track(withPage("a", 5_000, hang));
    const b = track(withPage("b", 5_000, hang));
    await advance(250);
    expect(browserPagesInUse()).toBe(2);
    const c = track(withPage("c", 3_000, async () => "c")); // waits for a slot, budget 3s
    const d = track(withPage("d", 10_000, async () => "d")); // waits, budget 10s
    await advance(3_250);
    expect(c.error).toBeInstanceOf(StageTimeoutError); // gave up while queued
    expect(browserPagesInUse()).toBe(2);
    await advance(2_000); // a + b overrun at 5s → slots released at once
    expect(a.error).toBeInstanceOf(StageTimeoutError);
    expect(b.error).toBeInstanceOf(StageTimeoutError);
    expect(d.value).toBe("d"); // the remaining waiter got a slot
    expect(browserPagesInUse()).toBe(0);
    expect(browser.pages.every((p) => p.close.mock.calls.length > 0)).toBe(true);
  });
});

describe("findBrowserExecutables (async fs only)", () => {
  function fakeFs(platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}): ResolveDeps {
    const set = new Set(files);
    return {
      env,
      platform,
      arch: "x64",
      home: platform === "win32" ? "C:\\Users\\joey" : "/home/joey",
      exists: async (p) => set.has(p),
      listDir: async (dir) => {
        const sep = platform === "win32" ? "\\" : "/";
        const prefix = dir.endsWith(sep) ? dir : dir + sep;
        return [
          ...new Set(
            files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split(sep)[0]!),
          ),
        ];
      },
    };
  }

  it("Windows: bundled Chrome for Testing (newest first) → headless shell → Playwright → system Chrome", async () => {
    const cache = "C:\\Users\\joey\\.cache\\puppeteer";
    const files = [
      `${cache}\\chrome\\win64-130.0.6723.58\\chrome-win64\\chrome.exe`,
      `${cache}\\chrome\\win64-131.0.6778.85\\chrome-win64\\chrome.exe`,
      `${cache}\\chrome-headless-shell\\win64-131.0.6778.85\\chrome-headless-shell-win64\\chrome-headless-shell.exe`,
      "C:\\Users\\joey\\AppData\\Local\\ms-playwright\\chromium-1194\\chrome-win\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const { found, reason } = await findBrowserExecutables(
      fakeFs("win32", files, {
        LOCALAPPDATA: "C:\\Users\\joey\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
      }),
    );
    expect(reason).toBeNull();
    expect(found.map((f) => f.path)).toEqual([files[1], files[0], files[2], files[3], files[4]]);
    expect(found.map((f) => f.headlessShell)).toEqual([false, false, true, false, false]);
  });

  it("PUPPETEER_EXECUTABLE_PATH, when set, is the only candidate", async () => {
    const files = ["D:\\chrome\\chrome.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
    const set = await findBrowserExecutables(
      fakeFs("win32", files, { PUPPETEER_EXECUTABLE_PATH: "D:\\chrome\\chrome.exe" }),
    );
    expect(set.found.map((f) => f.path)).toEqual(["D:\\chrome\\chrome.exe"]);
    const missing = await findBrowserExecutables(
      fakeFs("win32", files, { PUPPETEER_EXECUTABLE_PATH: "D:\\gone\\chrome.exe" }),
    );
    expect(missing).toEqual({ found: [], reason: "PUPPETEER_EXECUTABLE_PATH not found" });
  });

  it("nothing installed → a reason, and puppeteer's D:\\ guesses are never probed", async () => {
    const probed: string[] = [];
    const deps = fakeFs("win32", []);
    const { found, reason } = await findBrowserExecutables({
      ...deps,
      exists: async (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(found).toEqual([]);
    expect(reason).toBe("no Chrome/Chromium found");
    expect(probed.some((p) => p.startsWith("D:"))).toBe(false);
  });
});
