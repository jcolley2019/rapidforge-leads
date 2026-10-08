/**
 * Build-demo routes (RFL.DEMO.1) against the real Express app on an
 * ephemeral port with MemoryStore + fixture seams, like http.test.ts. The
 * demos child process is a fake: tests feed it stderr lines and a final
 * stdout JSON line, then close it with an exit code.
 */
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import type { ChildLike, SpawnFn } from "./demo";
import { createApp } from "./http";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FIXTURE_DETAILS } from "./lib/places/fixtures";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import { FixtureScreenshotCapturer, FixtureScreenshotStorage } from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import type { OrchestratorDeps } from "./orchestrator";
import type { QueuePoller } from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  log(line: string): void {
    this.stderr.write(`${line}\n`);
  }
  result(json: unknown): void {
    this.stdout.write(`${JSON.stringify(json)}\n`);
  }
  close(code: number): void {
    this.stdout.end();
    this.stderr.end();
    // Let the stream data events flush before 'close', as a real child does.
    setImmediate(() => this.emit("close", code, null));
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  child: FakeChild;
}

const spawnCalls: SpawnCall[] = [];
const fakeSpawn: SpawnFn = (command, args, options) => {
  const child = new FakeChild();
  spawnCalls.push({ command, args: [...args], cwd: options.cwd, child });
  return child;
};

let store: MemoryStore;
let server: Server;
let base: string;
let demosDir: string | undefined = "C:\\dev\\rapidforge-demos";

const idlePoller: QueuePoller = {
  status: "polling",
  stop() {},
  inFlight: () => 0,
  inFlightJobs: () => [],
  tick: async () => undefined,
  abortJobsForSearch: async () => [],
};

function makeDeps(s: MemoryStore): OrchestratorDeps {
  return {
    store: s,
    places: new FixturePlacesClient(),
    probe: new FixtureWebProbe(),
    psi: new FixturePsiClient(),
    site: new FixtureSiteFetcher(),
    screenshotCapturer: new FixtureScreenshotCapturer(),
    screenshotStorage: new FixtureScreenshotStorage(),
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  token = "dev-offline",
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForSpawn(n: number): Promise<SpawnCall> {
  await waitFor(() => spawnCalls.length >= n, `spawn #${n}`);
  return spawnCalls[n - 1]!;
}

async function waitForSettled(businessId: string): Promise<Business> {
  await waitFor(async () => (await store.getBusiness(businessId))?.demo_status !== "building", "build to settle");
  return (await store.getBusiness(businessId))!;
}

async function seedLead(opts: { withBrief?: boolean; audited?: boolean } = {}): Promise<Business> {
  const { withBrief = true, audited = true } = opts;
  const search = await store.createSearch({
    workspace_id: DEV_WORKSPACE_ID,
    created_by: DEV_USER_ID,
    mode: "zip_radius",
    params: { zip: "83704", radius_miles: 10 },
    category: "plumber",
  });
  const suffix = Math.random().toString(36).slice(2, 7);
  const business = await store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: `fx-${suffix}`,
    name: `All Plumbing & Sewer ${suffix}`,
    phone: "(208) 555-0102",
    website_url: "https://boisedrainpros.wixsite.com/home",
    address: "7800 W Fairview Ave, Boise, ID 83704",
    lat: 43.62,
    lng: -116.28,
    google_rating: 4.5,
    review_count: 89,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    places_details: {
      ...FIXTURE_DETAILS["fx-001"],
      displayName: { text: "All Plumbing & Sewer" },
      fetchedAt: "2026-07-06T07:00:00.000Z",
    },
  });
  await store.ensureSearchResult(DEV_WORKSPACE_ID, search.id, business.id);
  if (audited) {
    await store.insertAudit({
      workspace_id: DEV_WORKSPACE_ID,
      business_id: business.id,
      website_url: business.website_url,
      http_status: 200,
      response_ms: 800,
      ssl_valid: true,
      website_health_score: 36,
      star_grade: 2,
      sellability_score: 82,
      score_breakdown: {},
      issues: [{ severity: "high", label: "Slow on mobile" }],
      status: "completed",
      error_message: null,
      completed_at: "2026-07-05T00:00:00.000Z",
    }).then((audit) =>
      withBrief
        ? store.updateAudit(audit.id, { design_brief: { business_name: "All Plumbing & Sewer", stored: true } })
        : undefined,
    );
  }
  return business;
}

const designRuns = (businessId: string) =>
  store.listAgentRuns().filter((r) => r.target_id === businessId && r.agent_name === "design-brief").length;

const SUCCESS = {
  ok: true,
  businessId: "x",
  slug: "all-plumbing-sewer",
  sub: "allplumbing",
  previewUrl: "https://rapidforge-demos-abc123.vercel.app",
  aliasUrl: "https://allplumbing.demos.rapidforge.ai",
  aliasOk: false,
  durationMs: 91_000,
};

beforeAll(async () => {
  store = new MemoryStore();
  const app = createApp(makeDeps(store), idlePoller, Date.now(), {
    demo: {
      spawn: fakeSpawn,
      kill: (child) => child.kill(),
      demosDir: () => demosDir,
      timeoutMs: 200,
      now: () => new Date("2026-10-07T18:00:00.000Z"),
    },
  });
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  spawnCalls.length = 0;
  demosDir = "C:\\dev\\rapidforge-demos";
});

afterEach(async () => {
  // Never leave a fake child open across tests (it would hit the timeout).
  for (const call of spawnCalls) {
    if (!call.child.killed) call.child.close(0);
  }
});

describe("POST /api/businesses/:id/demo", () => {
  it("202s, runs npm run demo in DEMOS_DIR, and lands the result on the business", async () => {
    const business = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/demo`, { sub: "allplumbing" });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: "building" });

    const call = await waitForSpawn(1);
    expect(call.command).toBe("npm");
    expect(call.args).toEqual(["run", "demo", "--", "--lead", business.id, "--as", "allplumbing"]);
    expect(call.cwd).toBe("C:\\dev\\rapidforge-demos");
    expect((await store.getBusiness(business.id))?.demo_status).toBe("building");

    call.child.log("▸ Intake: all-plumbing-sewer");
    call.child.log("▸ Build: 5 variants");
    call.child.log("▸ Deploy: vercel");
    call.child.result({ ...SUCCESS, businessId: business.id });
    call.child.close(0);

    const settled = await waitForSettled(business.id);
    expect(settled).toMatchObject({
      demo_status: "ready",
      demo_url: "https://allplumbing.demos.rapidforge.ai",
      demo_preview_url: "https://rapidforge-demos-abc123.vercel.app",
      demo_sub: "allplumbing",
      demo_built_at: "2026-10-07T18:00:00.000Z",
      demo_error: null,
    });
    // The stored brief was reused — no design-brief agent run.
    expect(designRuns(business.id)).toBe(0);

    const status = await api("GET", `/api/businesses/${business.id}/demo`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      demo_status: "ready",
      demo_url: "https://allplumbing.demos.rapidforge.ai",
      alias_ok: false,
    });
    expect(status.json.log).toContain("▸ Deploy: vercel");
    expect(status.json.log.at(-1)).toMatch(/Demo ready: https:\/\/allplumbing\.demos\.rapidforge\.ai \(public link goes live once DNS/);
  });

  it("generates the Design Brief first when the lead has none (ensureDesignBrief)", async () => {
    const business = await seedLead({ withBrief: false });
    expect((await store.getLatestCompletedAuditForBusiness(business.id))?.design_brief).toBeFalsy();

    const res = await api("POST", `/api/businesses/${business.id}/demo`);
    expect(res.status).toBe(202);

    const call = await waitForSpawn(1);
    // Brief generated (fixture-mode template) and persisted BEFORE the spawn.
    expect(designRuns(business.id)).toBe(1);
    const audit = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(audit?.design_brief).toMatchObject({ vertical: "plumber" });
    expect(call.args).toEqual(["run", "demo", "--", "--lead", business.id]); // no --as → CLI default

    call.child.result({ ...SUCCESS, businessId: business.id, aliasOk: true });
    call.child.close(0);
    const settled = await waitForSettled(business.id);
    expect(settled.demo_status).toBe("ready");
  });

  it("a failure JSON line → failed with 'stage: error'", async () => {
    const business = await seedLead();
    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const call = await waitForSpawn(1);
    call.child.log("▸ Deploy: vercel");
    call.child.log("✖ vercel deploy exited 1");
    call.child.result({ ok: false, stage: "deploy", error: "vercel deploy exited 1" });
    call.child.close(1);

    const settled = await waitForSettled(business.id);
    expect(settled.demo_status).toBe("failed");
    expect(settled.demo_error).toBe("deploy: vercel deploy exited 1");
    expect(settled.demo_url ?? null).toBeNull();
  });

  it("a non-zero exit without a JSON line → failed with the last stderr line", async () => {
    const business = await seedLead();
    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const call = await waitForSpawn(1);
    call.child.log("▸ Intake: all-plumbing-sewer");
    call.child.log("Error: ENOENT no such file .env");
    call.child.close(1);

    const settled = await waitForSettled(business.id);
    expect(settled.demo_status).toBe("failed");
    expect(settled.demo_error).toBe("Error: ENOENT no such file .env");
  });

  it("409s a second POST while the first build is running; a rebuild works after it settles", async () => {
    const business = await seedLead();
    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const call = await waitForSpawn(1);

    const again = await api("POST", `/api/businesses/${business.id}/demo`);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/already running/);
    expect(spawnCalls).toHaveLength(1);

    call.child.result({ ...SUCCESS, businessId: business.id });
    call.child.close(0);
    await waitForSettled(business.id);

    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const second = await waitForSpawn(2);
    second.child.result({ ...SUCCESS, businessId: business.id });
    second.child.close(0);
    await waitForSettled(business.id);
  });

  it("503s when DEMOS_DIR is not configured", async () => {
    demosDir = undefined;
    const business = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/demo`);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "DEMOS_DIR not configured" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("409s 'No completed audit' when there is nothing to brief from", async () => {
    const business = await seedLead({ audited: false });
    const res = await api("POST", `/api/businesses/${business.id}/demo`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("No completed audit");
    expect(spawnCalls).toHaveLength(0);
  });

  it("400s a sub that is not a DNS label; 404s a foreign business", async () => {
    const business = await seedLead();
    const bad = await api("POST", `/api/businesses/${business.id}/demo`, { sub: "All Plumbing!" });
    expect(bad.status).toBe(400);
    expect(spawnCalls).toHaveLength(0);
    const foreign = await api("POST", "/api/businesses/nope/demo");
    expect(foreign.status).toBe(404);
  });

  it("kills the child and fails the build on timeout", async () => {
    const business = await seedLead();
    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const call = await waitForSpawn(1);
    call.child.log("▸ Build: hanging");

    const settled = await waitForSettled(business.id);
    expect(call.child.killed).toBe(true);
    expect(settled.demo_status).toBe("failed");
    expect(settled.demo_error).toMatch(/^timeout:/);
  });
});

describe("GET /api/businesses/:id/demo", () => {
  it("returns null fields and an empty log before any build", async () => {
    const business = await seedLead();
    const res = await api("GET", `/api/businesses/${business.id}/demo`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      demo_status: null,
      demo_url: null,
      demo_preview_url: null,
      demo_sub: null,
      demo_built_at: null,
      demo_error: null,
      log: [],
      alias_ok: null,
    });
  });

  it("keeps only the last 50 log lines of a running build", async () => {
    const business = await seedLead();
    expect((await api("POST", `/api/businesses/${business.id}/demo`)).status).toBe(202);
    const call = await waitForSpawn(1);
    for (let i = 1; i <= 60; i += 1) call.child.log(`line ${i}`);
    await waitFor(async () => (await api("GET", `/api/businesses/${business.id}/demo`)).json.log.at(-1) === "line 60", "log tail");

    const mid = await api("GET", `/api/businesses/${business.id}/demo`);
    expect(mid.json.demo_status).toBe("building");
    expect(mid.json.log).toHaveLength(50);
    expect(mid.json.log[0]).toBe("line 11");
    expect(mid.json.log.at(-1)).toBe("line 60");

    call.child.result({ ...SUCCESS, businessId: business.id });
    call.child.close(0);
    await waitForSettled(business.id);
  });

  it("404s a foreign business", async () => {
    const res = await api("GET", "/api/businesses/nope/demo");
    expect(res.status).toBe(404);
  });
});
