/**
 * Chain detection (audit finding 3): name normalizer, token-prefix brand
 * matching in both directions, URL store-locator heuristics (the live
 * shapes the audit found + the negatives that must stay independents).
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_CHAIN_BRANDS,
  chainUrlSignals,
  detectChain,
  domainSharesNameToken,
  isChainLikeUrl,
  isKnownChainName,
  matchKnownChainBrand,
  normalizeBusinessName,
  registrableDomainLabel,
} from "./chains";

describe("normalizeBusinessName", () => {
  it.each([
    ["  Boise   Plumbing Co. ", "boise plumbing"],
    ["Roto-Rooter!", "roto rooter"],
    ["Great Clips - Nampa", "great clips"],
    ["Great Clips – Nampa Marketplace", "great clips"],
    ["Supercuts | Boise Towne Square", "supercuts"],
    ["Sport Clips Haircuts #4471", "sport clips haircuts"],
    ["Ulta Beauty (Meridian)", "ulta beauty"],
    ["Mr. Rooter Plumbing of Boise", "mr rooter plumbing"],
    ["SERVPRO of Nampa / Caldwell", "servpro"],
    ["The Home Depot", "home depot"],
    ["Ten Mile Plumbing LLC", "ten mile plumbing"],
    ["Snake River Plumbing, Inc.", "snake river plumbing"],
    ["Joe's Submarine Sandwiches", "joes submarine sandwiches"],
    ["Home Services at The Home Depot", "home services at the home depot"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeBusinessName(input)).toBe(expected);
  });

  it("is stable: normalizing twice changes nothing", () => {
    for (const n of ["Great Clips - Nampa #12", "Boise Plumbing Co.", "LLC"]) {
      const once = normalizeBusinessName(n);
      expect(normalizeBusinessName(once)).toBe(once);
    }
  });
});

describe("isKnownChainName (token-prefix match)", () => {
  it("has a solid brand list covering the required names", () => {
    expect(KNOWN_CHAIN_BRANDS.length).toBeGreaterThan(300);
    expect(new Set(KNOWN_CHAIN_BRANDS).size).toBe(KNOWN_CHAIN_BRANDS.length); // no duplicates
    for (const required of [
      "Ulta",
      "Supercuts",
      "Sport Clips",
      "Great Clips",
      "SmartStyle",
      "Fantastic Sams",
      "Paul Mitchell The School",
      "European Wax Center",
      "Radiant Waxing",
      "Roto-Rooter",
      "Mr. Rooter",
      "Benjamin Franklin Plumbing",
      "ARS",
      "One Hour Heating & Air Conditioning",
      "Aspen Dental",
      "Planet Fitness",
      "Anytime Fitness",
      "Orangetheory",
      "Jiffy Lube",
      "Midas",
      "Cookie Cutters",
    ]) {
      expect(isKnownChainName(required), required).toBe(true);
    }
  });

  it("matches brands with a location suffix or trailing words", () => {
    expect(matchKnownChainBrand("Great Clips Nampa")).toBe("great clips");
    expect(matchKnownChainBrand("Great Clips - Boise Towne Plaza #1234")).toBe("great clips");
    expect(matchKnownChainBrand("Sport Clips Haircuts of Meridian")).toBe("sport clips haircuts");
    expect(matchKnownChainBrand("Ulta Beauty")).toBe("ulta beauty");
    expect(matchKnownChainBrand("Roto-Rooter Plumbing & Water Cleanup")).toBe("roto rooter");
    expect(matchKnownChainBrand("Mr. Rooter Plumbing of Boise")).toBe("mr rooter plumbing");
    expect(matchKnownChainBrand("SERVPRO of Nampa")).toBe("servpro");
    expect(matchKnownChainBrand("Home Services at The Home Depot")).toBe(
      "home services at the home depot",
    );
    expect(matchKnownChainBrand("The Home Depot")).toBe("home depot");
    expect(matchKnownChainBrand("Cookie Cutters Haircuts for Kids")).toBe("cookie cutters");
    expect(matchKnownChainBrand("Paul Mitchell The School Boise")).toBe(
      "paul mitchell the school",
    );
  });

  it("does not match a brand that appears later in the name (prefix, not substring)", () => {
    expect(isKnownChainName("Clip Joint")).toBe(false);
    expect(isKnownChainName("The Clip Joint Barbershop")).toBe(false);
    expect(isKnownChainName("Not Your Great Clips Salon")).toBe(false);
    expect(isKnownChainName("Boise Midas Touch Massage")).toBe(false);
    expect(isKnownChainName("Supercutsy Pet Grooming")).toBe(false); // partial token
    expect(isKnownChainName("Joe's Submarine Sandwiches")).toBe(false); // ≠ subway
    expect(isKnownChainName("Snake River Plumbing Co")).toBe(false);
    expect(isKnownChainName("Eagle Rapid Rooter")).toBe(false); // ≠ roto rooter
    expect(isKnownChainName("Paul Mitchell Focus Salon")).toBe(false); // product line, not the school
    // Common-word brands are exact-only: the chain itself still matches.
    expect(isKnownChainName("Target Pest Control")).toBe(false);
    expect(isKnownChainName("Target")).toBe(true);
    expect(isKnownChainName("Midas Touch Massage")).toBe(false);
    expect(isKnownChainName("Midas")).toBe(true);
    expect(isKnownChainName("Midas Auto Service Experts")).toBe(true);
    expect(isKnownChainName("Shell Point Plumbing")).toBe(false);
    expect(isKnownChainName("Subway")).toBe(true);
    expect(isKnownChainName("Spectrum Heating & Cooling")).toBe(false);
    expect(isKnownChainName("")).toBe(false);
  });
});

describe("isChainLikeUrl", () => {
  it.each([
    // The store-locator shapes the audit found live (finding 3).
    ["Great Clips", "https://salons.greatclips.com/us/id/nampa/1220-caldwell-blvd"],
    ["Sport Clips Haircuts", "https://locations.sportclips.com/id/boise/boise-towne-plaza"],
    ["Ulta Beauty", "https://www.ulta.com/stores/boise-id-1095"],
    ["Home Services at The Home Depot", "https://www.homedepot.com/l/Boise/ID/Boise/83704/1803"],
    ["SmartStyle Hair Salon", "https://local.smartstyle.com/id/boise/5825-e-franklin-rd"],
    [
      "European Wax Center",
      "https://www.europeanwax.com/locations/id/boise/boise-village?utm_source=google&utm_medium=organic&utm_campaign=gmb",
    ],
    ["Jiffy Lube Multicare", "https://www.jiffylube.com/locations/id/boise/2345"],
    // A DBA franchisee pointing at the franchisor's directory.
    ["Treasure Valley Heating & Air", "https://www.onehourheatandair.com/locations/boise-id/"],
    // Locator segments on a foreign domain.
    ["Capital City Smiles", "https://www.aspendental.com/dentist/nearme/boise-id"],
    ["Fit Body Boise", "https://www.planetfitness.com/store-locator/id-boise-overland"],
  ])("flags %s → %s", (name, url) => {
    expect(isChainLikeUrl(url, name)).toBe(true);
  });

  it.each([
    // One-location salon whose own site has a "find us" page: no other signal.
    ["Luxe Salon Boise", "https://luxesalonboise.com/locations/"],
    ["Luxe Salon Boise", "https://www.luxesalonboise.com/locations/find-us"],
    // Independents with ordinary URLs.
    ["Snake River Plumbing Co", "https://snakeriverplumbing.com"],
    ["Boise Plumbing Co", "https://boiseplumbingco.com/west"],
    ["Gem State Handyman", "https://gemstatehandy.com/"],
    ["Boise Drain Pros", "https://boisedrainpros.wixsite.com/home"],
    // GBP tracking alone never flags.
    ["Snake River Plumbing Co", "https://snakeriverplumbing.com/?utm_source=google&utm_campaign=gmb"],
    // A mismatched domain alone (branding ≠ legal name) never flags.
    ["Nampa Rooter & Drain", "https://fastdrains.net/"],
    // A zip code in the path is not a store number.
    ["Luxe Salon Boise", "https://luxesalonboise.com/locations/boise-83704"],
    // Social links and junk never flag.
    ["Any Business", "https://www.facebook.com/anybusiness"],
    ["Any Business", "not a url"],
    ["Any Business", null],
  ])("does not flag %s → %s", (name, url) => {
    expect(isChainLikeUrl(url, name)).toBe(false);
  });

  it("utm gmb tracking only tips the borderline own-domain locator case", () => {
    const base = "https://www.europeanwax.com/locations/id/boise/boise-village";
    expect(isChainLikeUrl(base, "European Wax Center")).toBe(false);
    expect(isChainLikeUrl(`${base}?utm_campaign=gmb`, "European Wax Center")).toBe(true);
    expect(isChainLikeUrl(`${base}?utm_campaign=spring-sale`, "European Wax Center")).toBe(false);
    // Own domain, no locator path: utm does nothing.
    expect(isChainLikeUrl("https://www.europeanwax.com/?utm_campaign=gmb", "European Wax Center")).toBe(false);
  });

  it("exposes the individual signals", () => {
    expect(
      chainUrlSignals("https://www.homedepot.com/l/Boise/ID/Boise/83704/1803", "Home Services at The Home Depot"),
    ).toEqual({
      locatorSubdomain: false,
      locatorPath: true,
      numericStoreId: true,
      domainSharesName: true,
      gbpTracking: false,
    });
    expect(chainUrlSignals("nope", "x")).toBeNull();
  });

  it("domain ↔ name token sharing", () => {
    expect(registrableDomainLabel("salons.greatclips.com")).toBe("greatclips");
    expect(registrableDomainLabel("www.example.co.uk")).toBe("example");
    expect(domainSharesNameToken("greatclips", "Great Clips Nampa")).toBe(true);
    expect(domainSharesNameToken("luxesalonboise", "Luxe Salon Boise")).toBe(true);
    expect(domainSharesNameToken("onehourheatandair", "Treasure Valley Heating & Air")).toBe(false);
    // "drain" is a strong token the domain carries — plausibly its own site.
    expect(domainSharesNameToken("fastdrains", "Nampa Rooter & Drain")).toBe(true);
    expect(domainSharesNameToken("example", "Nampa Rooter & Drain")).toBe(false);
    // Generic trade words never tie a domain to a name.
    expect(domainSharesNameToken("boiseplumbing", "Plumbing Services")).toBe(false);
  });
});

describe("detectChain", () => {
  it("labels the reason by precedence: brand, then URL, then multi-location", () => {
    expect(
      detectChain("Great Clips", "https://salons.greatclips.com/us/id/nampa/1", true),
    ).toEqual({ isChain: true, reason: "known_brand" });
    expect(
      detectChain("Treasure Valley Heating & Air", "https://www.onehourheatandair.com/locations/boise-id/", true),
    ).toEqual({ isChain: true, reason: "url_shape" });
    expect(detectChain("Boise Plumbing Co", "https://boiseplumbingco.com/west", true)).toEqual({
      isChain: true,
      reason: "multi_location",
    });
    expect(detectChain("Boise Plumbing Co", "https://boiseplumbingco.com", false)).toEqual({
      isChain: false,
      reason: null,
    });
  });
});
