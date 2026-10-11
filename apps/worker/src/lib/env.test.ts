import { describe, expect, it } from "vitest";
import { LOCAL_WEB_ORIGIN, webOrigins } from "./env";

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
