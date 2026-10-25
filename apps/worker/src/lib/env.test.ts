import { describe, expect, it } from "vitest";
import { LOCAL_WEB_ORIGIN, psiMobileRuns, webOrigins } from "./env";

describe("psiMobileRuns (RFL.PSI.1)", () => {
  it("defaults to 2 when unset, blank or not an integer", () => {
    expect(psiMobileRuns({})).toBe(2);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "  " })).toBe(2);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "two" })).toBe(2);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "1.5" })).toBe(2);
  });

  it("reads an integer and clamps it to 1–3", () => {
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "1" })).toBe(1);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: " 3 " })).toBe(3);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "0" })).toBe(1);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "-4" })).toBe(1);
    expect(psiMobileRuns({ PSI_MOBILE_RUNS: "9" })).toBe(3);
  });
});

describe("webOrigins (RFL.HOST.6)", () => {
  it("is localhost only when WEB_ORIGINS is unset or blank", () => {
    expect(webOrigins({})).toEqual([LOCAL_WEB_ORIGIN]);
    expect(webOrigins({ WEB_ORIGINS: " , " })).toEqual([LOCAL_WEB_ORIGIN]);
  });

  it("adds trimmed comma-separated origins after localhost, without trailing slashes or duplicates", () => {
    expect(
      webOrigins({
        WEB_ORIGINS: " https://rapidforge.vercel.app/ ,https://app.rapidforge.ai,http://localhost:5173",
      }),
    ).toEqual([LOCAL_WEB_ORIGIN, "https://rapidforge.vercel.app", "https://app.rapidforge.ai"]);
  });
});
