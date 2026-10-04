import { afterEach, describe, expect, it } from "vitest";
import {
  createScreenshotCapturer,
  createScreenshotStorage,
  DisabledScreenshotCapturer,
  FIXTURE_SCREENSHOT_ROUTE,
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
  NoopScreenshotStorage,
  screenshotSlug,
} from "./screenshots";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe("screenshotSlug", () => {
  it("slugs a URL's hostname", () => {
    expect(screenshotSlug("https://www.rotorooter.com/boise")).toBe(
      "www-rotorooter-com",
    );
    expect(screenshotSlug("https://boisedrainpros.wixsite.com/")).toBe(
      "boisedrainpros-wixsite-com",
    );
  });

  it("degrades gracefully on non-URLs", () => {
    expect(screenshotSlug("not a url")).toBe("not-a-url");
  });
});

describe("FixtureScreenshotCapturer", () => {
  it("serves the committed pair for a fixture host", async () => {
    const set = await new FixtureScreenshotCapturer().capture(
      "https://boisedrainpros.wixsite.com/",
    );
    expect(set).not.toBeNull();
    expect(set!.fixtureBaseName).toBe("boisedrainpros-wixsite-com");
    expect(set!.desktop.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    expect(set!.mobile.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  });

  it("falls back to the generic pair for unknown hosts", async () => {
    const set = await new FixtureScreenshotCapturer().capture(
      "https://totally-unknown-host.example/",
    );
    expect(set).not.toBeNull();
    expect(set!.fixtureBaseName).toBe("fallback");
    expect(set!.desktop.length).toBeGreaterThan(0);
  });
});

describe("FixtureScreenshotStorage", () => {
  it("stores relative static URLs for the resolved fixture pair", async () => {
    const capturer = new FixtureScreenshotCapturer();
    const set = await capturer.capture("https://meridianwaterheater.com/");
    const urls = await new FixtureScreenshotStorage().store(
      "biz-1",
      "audit-1",
      set!,
      screenshotSlug("https://meridianwaterheater.com/"),
    );
    expect(urls).toEqual({
      desktop_url: `${FIXTURE_SCREENSHOT_ROUTE}/meridianwaterheater-com-desktop.jpg`,
      mobile_url: `${FIXTURE_SCREENSHOT_ROUTE}/meridianwaterheater-com-mobile.jpg`,
    });
  });

  it("uses the fallback base name when the capturer fell back", async () => {
    const set = await new FixtureScreenshotCapturer().capture(
      "https://totally-unknown-host.example/",
    );
    const urls = await new FixtureScreenshotStorage().store(
      "biz-1",
      "audit-1",
      set!,
      "totally-unknown-host-example",
    );
    expect(urls!.desktop_url).toBe(
      `${FIXTURE_SCREENSHOT_ROUTE}/fallback-desktop.jpg`,
    );
  });
});

describe("factories", () => {
  const saved = {
    force: process.env.RAPIDFORGE_FORCE_FIXTURES,
    places: process.env.GOOGLE_PLACES_API_KEY,
    supabase: process.env.SUPABASE_URL,
    serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
    screenshots: process.env.SCREENSHOTS_ENABLED,
  };

  afterEach(() => {
    if (saved.force === undefined) delete process.env.RAPIDFORGE_FORCE_FIXTURES;
    else process.env.RAPIDFORGE_FORCE_FIXTURES = saved.force;
    if (saved.places === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = saved.places;
    if (saved.supabase === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.supabase;
    if (saved.serviceRole === undefined)
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.serviceRole;
    if (saved.screenshots === undefined) delete process.env.SCREENSHOTS_ENABLED;
    else process.env.SCREENSHOTS_ENABLED = saved.screenshots;
  });

  it("live mode defaults to the disabled capturer (SCREENSHOTS_ENABLED unset — RFL.QUEUE.8a)", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    delete process.env.SCREENSHOTS_ENABLED;
    const capturer = createScreenshotCapturer();
    expect(capturer.mode).toBe("disabled");
    expect(capturer).toBeInstanceOf(DisabledScreenshotCapturer);
    process.env.SCREENSHOTS_ENABLED = "1"; // only the literal "true" opts in
    expect(createScreenshotCapturer().mode).toBe("disabled");
  });

  it("fixture mode keeps its pre-rendered JPEGs regardless of the switch (no browser)", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.SCREENSHOTS_ENABLED;
    expect(createScreenshotCapturer().mode).toBe("fixture");
  });

  it("RAPIDFORGE_FORCE_FIXTURES wins regardless of keys", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "true";
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    expect(createScreenshotCapturer().mode).toBe("fixture");
    expect(createScreenshotStorage().mode).toBe("fixture-static");
  });

  it("pairs with the Places key like site/probe (no key → fixture)", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(createScreenshotCapturer().mode).toBe("fixture");
    expect(createScreenshotStorage().mode).toBe("fixture-static");
  });

  it("real capture without Supabase → real capturer, noop storage", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    process.env.SCREENSHOTS_ENABLED = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(createScreenshotCapturer().mode).toBe("real");
    const storage = createScreenshotStorage();
    expect(storage.mode).toBe("none");
    expect(storage).toBeInstanceOf(NoopScreenshotStorage);
  });

  it("real capture with Supabase creds → supabase storage", () => {
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    expect(createScreenshotStorage().mode).toBe("supabase");
  });
});
