/**
 * Sprint 6 LIVE smoke test — the Design agent's real Sonnet-vision path
 * against three real business homepages spanning the modernity range.
 *
 *   npx tsx scripts/design-smoke.ts
 *
 * Screenshots are captured by the real PuppeteerScreenshotCapturer (local
 * Chrome, no cost); the critique goes to claude-sonnet-5-5 via lib/ai.ts.
 * MUST run WITHOUT RAPIDFORGE_FORCE_FIXTURES so aiSummaryMode() = "core".
 * Hard spend cap: aborts before any call once cumulative cost nears $1.
 */
import "dotenv/config";
import { runDesign } from "../src/agents/design";
import { aiSummaryMode } from "../src/lib/ai";
import { PuppeteerScreenshotCapturer } from "../src/lib/screenshots";

const CAP_CENTS = 100; // ~$1 hard ceiling (PRD 8 cost discipline)

const TARGETS = [
  { name: "Berkshire Hathaway", url: "https://www.berkshirehathaway.com/" },
  { name: "Craigslist", url: "https://www.craigslist.org/about/sites" },
  { name: "Stripe", url: "https://stripe.com/" },
];

function fakeBusiness(name: string, url: string) {
  return {
    id: `smoke-${name}`,
    website_url: url,
    name,
  } as unknown as Parameters<typeof runDesign>[0]["business"];
}

async function main() {
  const mode = aiSummaryMode();
  console.log(`ai_mode: ${mode}`);
  if (mode !== "core") {
    throw new Error(
      "aiSummaryMode is not 'core' — ANTHROPIC_API_KEY missing or RAPIDFORGE_FORCE_FIXTURES=true. Cannot run the live smoke test.",
    );
  }

  const capturer = new PuppeteerScreenshotCapturer();
  const now = new Date();
  let spentCents = 0;

  for (const target of TARGETS) {
    if (spentCents >= CAP_CENTS) {
      console.log(`\n[cap] $${(spentCents / 100).toFixed(2)} reached — stopping.`);
      break;
    }
    console.log(`\n=== ${target.name} — ${target.url} ===`);
    // RFL.QUEUE.8a: capture throws on failure (needs SCREENSHOTS_ENABLED=true).
    const screenshots = await capturer.capture(target.url).catch((err: unknown) => {
      console.log(`  screenshot capture FAILED (${err instanceof Error ? err.message : String(err)}) — skipping`);
      return null;
    });
    if (!screenshots) continue;
    console.log(
      `  captured desktop ${screenshots.desktop.length}B + mobile ${screenshots.mobile.length}B`,
    );

    const result = await runDesign({
      business: fakeBusiness(target.name, target.url),
      site: null, // template signals unused on the vision path
      screenshots,
      now,
    });
    spentCents += result.costCents;

    if (result.status !== "completed" || !result.output) {
      console.log(`  FAILED: ${result.error}`);
      continue;
    }
    const o = result.output;
    console.log(`  used_vision: ${o.used_vision}  model: ${result.modelUsed}`);
    console.log(
      `  modernity: ${o.modernity_0_100}/100   feels_like_year: ${o.feels_like_year}`,
    );
    console.log(
      `  guardrail_passed: ${result.guardrailPassed}${result.guardrailNotes ? " — " + result.guardrailNotes : ""}`,
    );
    console.log(
      `  tokens: ${result.tokensUsed}  cost: ${result.costCents}¢  (${result.durationMs}ms)`,
    );
    console.log("  reasoning:", o.reasoning);
    for (const dim of ["typography", "color", "imagery", "layout", "mobile"] as const) {
      const d = o.dimensions[dim];
      console.log(`  · ${dim} (${d.score_0_100}): ${d.notes}`);
    }
    for (const issue of o.critical_issues) {
      console.log(`  ! ${issue.issue}\n      evidence: ${issue.evidence}`);
    }
  }

  console.log(
    `\nTOTAL SPEND: ${spentCents}¢ ($${(spentCents / 100).toFixed(2)}) across ${TARGETS.length} businesses`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
