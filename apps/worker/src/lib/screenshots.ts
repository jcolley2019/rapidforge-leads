/**
 * Screenshots — the swappable capture + storage seam (Sprint 6, PRD 6.8).
 *
 * Two seams compose the pipeline:
 *   - ScreenshotCapturer: homepage → desktop (1440×900) + mobile (390×844)
 *     JPEG buffers. Real = puppeteer-core driving the locally installed
 *     Chrome (channel "chrome" — no bundled Chromium, zero cost). Fixture =
 *     pre-rendered JPEGs of the SITE_FIXTURES documents committed under
 *     apps/worker/fixtures/screenshots (no Chrome needed at runtime).
 *   - ScreenshotStorage: buffers → durable URLs on the audit row. Real =
 *     Supabase Storage bucket 'screenshots' (service-role upload, public
 *     read — bucket created by migration 0006). Fixture = the worker's own
 *     /fixtures/screenshots static route, stored as RELATIVE urls the web
 *     client resolves against its API base.
 *
 * Pairing rule (same as WebProbe/SiteFetcher): fixture Places URLs are
 * fake, so the fixture capturer is selected whenever GOOGLE_PLACES_API_KEY
 * is absent. Screenshots are enrichment, never a reason to fail an audit.
 *
 * RFL.QUEUE.8a: real (browser) capture is opt-in — without
 * SCREENSHOTS_ENABLED=true live mode gets the DisabledScreenshotCapturer and
 * the orchestrator skips the stage. When on, a real capture failure throws
 * (BrowserUnavailableError or the page error) so the orchestrator can record
 * a low "Screenshot unavailable (<reason>)" issue.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withPage } from "./browser";
import { forceFixtures, screenshotsEnabled } from "./env";

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** JPEG quality — screenshots are sales collateral, not pixel proofs. */
export const SCREENSHOT_JPEG_QUALITY = 80;

export const SCREENSHOT_NAV_TIMEOUT_MS = 30_000;

/** Directory of the committed fixture JPEGs (apps/worker/fixtures/screenshots). */
export const FIXTURE_SCREENSHOT_DIR = fileURLToPath(
  new URL("../../fixtures/screenshots", import.meta.url),
);

/** Public path prefix the worker serves FIXTURE_SCREENSHOT_DIR under. */
export const FIXTURE_SCREENSHOT_ROUTE = "/fixtures/screenshots";

export interface ScreenshotSet {
  desktop: Buffer;
  mobile: Buffer;
  contentType: "image/jpeg";
  /** Fixture capturer only: resolved fixture base name ("<slug>" | "fallback"). */
  fixtureBaseName?: string;
}

export interface ScreenshotUrls {
  /** Absolute (Supabase public URL) or relative ("/fixtures/…", web resolves). */
  desktop_url: string;
  mobile_url: string;
}

export interface ScreenshotCapturer {
  /** "disabled" = SCREENSHOTS_ENABLED is off: the stage is skipped. */
  readonly mode: "real" | "fixture" | "disabled";
  /**
   * Null or a throw = no screenshots (audit continues; screenshots stay
   * null). A throw's message becomes the "Screenshot unavailable" reason.
   */
  capture(url: string): Promise<ScreenshotSet | null>;
}

export interface ScreenshotStorage {
  readonly mode: "supabase" | "fixture-static" | "none";
  /** Null = nothing stored (audit continues; screenshots stay null). */
  store(
    businessId: string,
    auditId: string,
    set: ScreenshotSet,
    slug: string,
  ): Promise<ScreenshotUrls | null>;
}

/** Filesystem/URL-safe slug from a site URL's hostname. */
export function screenshotSlug(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Capturers
// ---------------------------------------------------------------------------

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export class PuppeteerScreenshotCapturer implements ScreenshotCapturer {
  readonly mode = "real" as const;

  /**
   * RFL.QUEUE.8: pages come from the process-wide shared browser (lazy
   * launch, 2 page slots); each shot runs under the 30s screenshot budget.
   * RFL.QUEUE.8a: no browser / timeout / page error → throws (the
   * orchestrator turns it into a low issue); the browser module already
   * logged a launch failure once, so nothing is logged here.
   */
  async capture(url: string): Promise<ScreenshotSet> {
    const shoot = (viewport: { width: number; height: number }, mobile: boolean) =>
      withPage(`screenshot-${mobile ? "mobile" : "desktop"}`, SCREENSHOT_NAV_TIMEOUT_MS, async (page) => {
        await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: mobile });
        if (mobile) await page.setUserAgent(MOBILE_USER_AGENT);
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: SCREENSHOT_NAV_TIMEOUT_MS,
        });
        // Let late webfonts/hero images settle before the shot.
        await new Promise((r) => setTimeout(r, 500));
        const data = await page.screenshot({
          type: "jpeg",
          quality: SCREENSHOT_JPEG_QUALITY,
        });
        return Buffer.from(data);
      });
    const desktop = await shoot(DESKTOP_VIEWPORT, false);
    const mobile = await shoot(MOBILE_VIEWPORT, true);
    return { desktop, mobile, contentType: "image/jpeg" };
  }
}

/** SCREENSHOTS_ENABLED off in live mode: no browser, the stage is skipped. */
export class DisabledScreenshotCapturer implements ScreenshotCapturer {
  readonly mode = "disabled" as const;

  async capture(): Promise<ScreenshotSet | null> {
    return null;
  }
}

export class FixtureScreenshotCapturer implements ScreenshotCapturer {
  readonly mode = "fixture" as const;

  constructor(private readonly dir: string = FIXTURE_SCREENSHOT_DIR) {}

  async capture(url: string): Promise<ScreenshotSet | null> {
    const slug = screenshotSlug(url);
    for (const base of [slug, "fallback"]) {
      try {
        const [desktop, mobile] = await Promise.all([
          readFile(`${this.dir}/${base}-desktop.jpg`),
          readFile(`${this.dir}/${base}-mobile.jpg`),
        ]);
        return { desktop, mobile, contentType: "image/jpeg", fixtureBaseName: base };
      } catch {
        // try the fallback pair
      }
    }
    console.warn(`[screenshots] no fixture screenshot pair for ${slug}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const SCREENSHOTS_BUCKET = "screenshots";

export class SupabaseScreenshotStorage implements ScreenshotStorage {
  readonly mode = "supabase" as const;

  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
  ) {}

  async store(
    businessId: string,
    auditId: string,
    set: ScreenshotSet,
  ): Promise<ScreenshotUrls | null> {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(this.supabaseUrl, this.serviceRoleKey);
      const bucket = client.storage.from(SCREENSHOTS_BUCKET);
      const upload = async (name: "desktop" | "mobile", body: Buffer) => {
        const path = `${businessId}/${auditId}/${name}.jpg`;
        const { error } = await bucket.upload(path, body, {
          contentType: set.contentType,
          upsert: true,
        });
        if (error) throw new Error(`${path}: ${error.message}`);
        return bucket.getPublicUrl(path).data.publicUrl;
      };
      const desktop_url = await upload("desktop", set.desktop);
      const mobile_url = await upload("mobile", set.mobile);
      return { desktop_url, mobile_url };
    } catch (err) {
      console.warn(
        `[screenshots] storage upload failed (is migration 0006's bucket applied?): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/** Fixture mode: the files already exist on disk; store their static URLs. */
export class FixtureScreenshotStorage implements ScreenshotStorage {
  readonly mode = "fixture-static" as const;

  async store(
    _businessId: string,
    _auditId: string,
    set: ScreenshotSet,
    slug: string,
  ): Promise<ScreenshotUrls | null> {
    const base = set.fixtureBaseName ?? slug;
    return {
      desktop_url: `${FIXTURE_SCREENSHOT_ROUTE}/${base}-desktop.jpg`,
      mobile_url: `${FIXTURE_SCREENSHOT_ROUTE}/${base}-mobile.jpg`,
    };
  }
}

/** Real capture with no Supabase: keep buffers for the Design agent, no URLs. */
export class NoopScreenshotStorage implements ScreenshotStorage {
  readonly mode = "none" as const;

  async store(): Promise<ScreenshotUrls | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factories (selection logged like every other seam)
// ---------------------------------------------------------------------------

export function createScreenshotCapturer(): ScreenshotCapturer {
  if (forceFixtures()) {
    console.log("[screenshots] capture mode: fixture (RAPIDFORGE_FORCE_FIXTURES)");
    return new FixtureScreenshotCapturer();
  }
  if (process.env.GOOGLE_PLACES_API_KEY) {
    if (screenshotsEnabled()) return new PuppeteerScreenshotCapturer();
    console.log(
      "[screenshots] capture mode: disabled — set SCREENSHOTS_ENABLED=true to capture with Chrome",
    );
    return new DisabledScreenshotCapturer();
  }
  console.log(
    "[screenshots] capture mode: fixture — pre-rendered fixture JPEGs",
  );
  return new FixtureScreenshotCapturer();
}

export function createScreenshotStorage(): ScreenshotStorage {
  if (forceFixtures() || !process.env.GOOGLE_PLACES_API_KEY) {
    return new FixtureScreenshotStorage();
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return new SupabaseScreenshotStorage(url, key);
  console.log(
    "[screenshots] storage mode: none — SUPABASE_URL absent; screenshots feed Design but are not persisted",
  );
  return new NoopScreenshotStorage();
}
