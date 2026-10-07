/**
 * createPlacesClient fixture guard (RFL.FIX.3j): fixture businesses must not
 * reach a Supabase-backed worker unless the operator opts in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOW_FIXTURES_IN_SUPABASE_ENV, createPlacesClient } from "./index";

const VARS = [
  "SUPABASE_URL",
  "GOOGLE_PLACES_API_KEY",
  "RAPIDFORGE_FORCE_FIXTURES",
  "RAPIDFORGE_FORCE_MEMORY_STORE",
  ALLOW_FIXTURES_IN_SUPABASE_ENV,
] as const;

describe("createPlacesClient fixture guard (RFL.FIX.3j)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  it("memory mode (no SUPABASE_URL) still serves fixtures", () => {
    expect(createPlacesClient().mode).toBe("fixture");
    process.env.RAPIDFORGE_FORCE_FIXTURES = "true";
    expect(createPlacesClient().mode).toBe("fixture");
  });

  it("refuses fixtures with SUPABASE_URL set, naming the opt-in variable", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.RAPIDFORGE_FORCE_FIXTURES = "true";
    expect(() => createPlacesClient()).toThrow(
      /refusing to start: fixture Places \(RAPIDFORGE_FORCE_FIXTURES=true\).*RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE=true/,
    );
    delete process.env.RAPIDFORGE_FORCE_FIXTURES;
    expect(() => createPlacesClient()).toThrow(/GOOGLE_PLACES_API_KEY absent/);
  });

  it("serves fixtures into Supabase only with the explicit opt-in", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.RAPIDFORGE_FORCE_FIXTURES = "true";
    process.env[ALLOW_FIXTURES_IN_SUPABASE_ENV] = "true";
    expect(createPlacesClient().mode).toBe("fixture");
  });

  it("a forced memory store is not Supabase — the offline E2E stack still starts", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.RAPIDFORGE_FORCE_FIXTURES = "true";
    process.env.RAPIDFORGE_FORCE_MEMORY_STORE = "true";
    expect(createPlacesClient().mode).toBe("fixture");
  });

  it("the real client is unaffected", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    expect(createPlacesClient().mode).toBe("google");
  });
});
