import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  extractCopyrightYear,
  hasRecentLastModified,
} from "./platform";
import { SITE_FIXTURES } from "./site-fixtures";

const noEvidence = { url: "", html: "", headers: {} };

function evidenceFor(host: string, url = `https://${host}`) {
  const fixture = SITE_FIXTURES[host]!;
  return { url, html: fixture.html, headers: fixture.headers };
}

describe("detectPlatform", () => {
  it("detects wix by builder subdomain", () => {
    expect(
      detectPlatform(evidenceFor("boisedrainpros.wixsite.com")),
    ).toBe("wix");
  });

  it("detects wix by HTML fingerprint on a custom domain", () => {
    expect(
      detectPlatform({
        url: "https://example.com",
        html: '<img src="https://static.wixstatic.com/media/x.jpg">',
        headers: {},
      }),
    ).toBe("wix");
  });

  it("detects godaddy by subdomain and wsimg assets", () => {
    expect(
      detectPlatform(evidenceFor("meridiancomfort.godaddysites.com")),
    ).toBe("godaddy");
    expect(
      detectPlatform({
        url: "https://example.com",
        html: '<p>Website Builder by GoDaddy</p>',
        headers: {},
      }),
    ).toBe("godaddy");
  });

  it("detects squarespace by host, assets, and Server header", () => {
    expect(
      detectPlatform(evidenceFor("kunaelectric.squarespace.com")),
    ).toBe("squarespace");
    expect(
      detectPlatform({
        url: "https://example.com",
        html: "<html></html>",
        headers: { server: "Squarespace" },
      }),
    ).toBe("squarespace");
  });

  it("detects wordpress by wp-content paths and generator meta", () => {
    expect(detectPlatform(evidenceFor("boiseplumbingco.com"))).toBe(
      "wordpress",
    );
    expect(
      detectPlatform(evidenceFor("starplumbingidaho.wordpress.com")),
    ).toBe("wordpress");
  });

  it("detects webflow by data-wf attributes and asset host", () => {
    expect(detectPlatform(evidenceFor("pipedreamidaho.webflow.io"))).toBe(
      "webflow",
    );
  });

  it("classifies unrecognized stacks as custom", () => {
    expect(detectPlatform(evidenceFor("snakeriverplumbing.com"))).toBe(
      "custom",
    );
    expect(detectPlatform(evidenceFor("meridianwaterheater.com"))).toBe(
      "custom",
    );
    expect(detectPlatform(noEvidence)).toBe("custom");
  });
});

describe("extractCopyrightYear", () => {
  const year = 2026;

  it.each([
    ["<p>&copy; 2026 Snake River Plumbing</p>", 2026],
    ["<p>© 2021 Boise Drain Pros</p>", 2021],
    ["<p>Copyright 2013 Meridian Water Heater Repair</p>", 2013],
    ["<p>(c) 2018 Example</p>", 2018],
    ["<p>Copyright 2019–2024 Example</p>", 2024],
    ["<p>&#169; 2020 Example</p>", 2020],
  ])("extracts from %s", (html, expected) => {
    expect(extractCopyrightYear(html, year)).toBe(expected);
  });

  it("returns the latest year when several appear", () => {
    expect(
      extractCopyrightYear("<p>© 2015 Old</p><p>© 2025 New</p>", year),
    ).toBe(2025);
  });

  it("ignores implausible years and returns null when absent", () => {
    expect(extractCopyrightYear("<p>© 1776 Example</p>", year)).toBeNull();
    expect(extractCopyrightYear("<p>© 2099 Example</p>", year)).toBeNull();
    expect(extractCopyrightYear("<p>no copyright here</p>", year)).toBeNull();
  });

  it("extracts from every fixture site that declares one", () => {
    expect(
      extractCopyrightYear(SITE_FIXTURES["snakeriverplumbing.com"]!.html, year),
    ).toBe(2026);
    expect(
      extractCopyrightYear(
        SITE_FIXTURES["starplumbingidaho.wordpress.com"]!.html,
        year,
      ),
    ).toBe(2019);
    expect(
      extractCopyrightYear(SITE_FIXTURES["meridianwaterheater.com"]!.html, year),
    ).toBe(2013);
  });
});

describe("hasRecentLastModified", () => {
  const now = new Date("2026-07-05T12:00:00Z");

  it("passes a header within the last year", () => {
    expect(
      hasRecentLastModified(
        { "last-modified": "Sat, 20 Jun 2026 08:12:00 GMT" },
        now,
      ),
    ).toBe(true);
  });

  it("fails an ancient header, a missing header, and garbage", () => {
    expect(
      hasRecentLastModified(
        { "last-modified": "Tue, 18 Mar 2014 09:30:00 GMT" },
        now,
      ),
    ).toBe(false);
    expect(hasRecentLastModified({}, now)).toBe(false);
    expect(hasRecentLastModified({ "last-modified": "not a date" }, now)).toBe(
      false,
    );
  });
});
