/**
 * Build-demo runner (RFL.DEMO.1). One click in the lead drawer runs
 * `npm run demo -- --lead <businessId> [--as <sub>]` in the rapidforge-demos
 * checkout (DEMOS_DIR) and lands the result on the business row:
 *
 *   building → ready  (demo_url / demo_preview_url / demo_sub / demo_built_at)
 *            → failed (demo_error)
 *
 * The demos CLI contract: progress goes to stderr ("▸ " lines are steps);
 * the LAST stdout line is JSON — {"ok":true,...} on success, or
 * {"ok":false,"stage","error"} with exit 1. A false aliasOk is NOT a
 * failure (DNS pending) — the alias URL is stored and the demo is ready.
 *
 * Each stderr line is broadcast as a `demo.log` AgentEvent on the workspace
 * channel and kept in memory (last LOG_CAP lines) so a reload mid-build
 * still shows progress. One build per business at a time (in-memory lock);
 * a 10-minute timeout kills the child.
 *
 * `spawn` is injected so tests drive a fake child process.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Business, DemoStatus } from "@rapidforge/shared";
import { broadcastAgentEvent } from "./events";
import type { DataStore } from "./store";

export const DEMO_TIMEOUT_MS = 10 * 60 * 1000;
export const LOG_CAP = 50;
/** A subdomain label under demos.rapidforge.ai — same rule as the demos CLI. */
export const DEMO_SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface DemoSuccess {
  ok: true;
  businessId: string;
  slug: string;
  sub: string;
  previewUrl: string;
  aliasUrl: string;
  aliasOk: boolean;
  durationMs: number;
}

export interface DemoFailure {
  ok: false;
  stage: string;
  error: string;
}

/** Structural slice of ChildProcess the runner uses (fakeable in tests). */
export interface ChildLike {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => ChildLike;

/**
 * Real spawn. npm is npm.cmd on Windows and Node refuses to spawn a .cmd
 * without a shell, so there the command goes through cmd.exe as ONE string
 * (args + shell:true is deprecated, DEP0190). Every arg is a fixed word, a
 * UUID or a DNS label validated by the route — nothing needs quoting.
 */
export const realSpawn: SpawnFn = (command, args, options) =>
  process.platform === "win32"
    ? nodeSpawn([command, ...args].join(" "), {
        cwd: options.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    : nodeSpawn(command, [...args], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

/**
 * Kill the child and, on Windows, the npm/node tree under cmd.exe —
 * child.kill() alone would leave the build running.
 */
export function killTree(child: ChildLike): void {
  if (process.platform === "win32" && child.pid) {
    try {
      nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // fall through to the plain kill
    }
  }
  child.kill("SIGKILL");
}

export interface DemoRunnerOptions {
  store: DataStore;
  /** Where rapidforge-demos is checked out; undefined → 503 at the route. */
  demosDir: () => string | undefined;
  spawn?: SpawnFn;
  kill?: (child: ChildLike) => void;
  timeoutMs?: number;
  now?: () => Date;
}

export interface DemoSnapshot {
  demo_status: DemoStatus | null;
  demo_url: string | null;
  demo_preview_url: string | null;
  demo_sub: string | null;
  demo_built_at: string | null;
  demo_error: string | null;
  /** Last LOG_CAP stderr lines of the running / most recent build. */
  log: string[];
  /** From the most recent build in this process; null after a restart. */
  alias_ok: boolean | null;
}

interface BuildState {
  log: string[];
  aliasOk: boolean | null;
  /** Resolves when the background build has settled (tests await it). */
  done: Promise<void>;
}

/** The last stdout line that parses as the demos result JSON. */
export function parseResultLine(stdout: string): DemoSuccess | DemoFailure | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.ok === true && typeof parsed.aliasUrl === "string") {
        return parsed as unknown as DemoSuccess;
      }
      if (parsed.ok === false) {
        return {
          ok: false,
          stage: typeof parsed.stage === "string" ? parsed.stage : "unknown",
          error: typeof parsed.error === "string" ? parsed.error : "unknown error",
        };
      }
    } catch {
      // not JSON — keep looking upward
    }
  }
  return null;
}

/** Split a stream into trimmed non-empty lines, buffering partial chunks. */
function onLines(stream: Readable | null, each: (line: string) => void): () => void {
  let buffer = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line) each(line);
    }
  });
  return () => {
    const line = buffer.trim();
    if (line) each(line);
    buffer = "";
  };
}

export class DemoRunner {
  private readonly builds = new Map<string, BuildState>();
  private readonly running = new Set<string>();

  constructor(private readonly opts: DemoRunnerOptions) {}

  demosDir(): string | undefined {
    const dir = this.opts.demosDir()?.trim();
    return dir ? dir : undefined;
  }

  isBuilding(businessId: string): boolean {
    return this.running.has(businessId);
  }

  logsFor(businessId: string): string[] {
    return [...(this.builds.get(businessId)?.log ?? [])];
  }

  snapshot(business: Business): DemoSnapshot {
    const build = this.builds.get(business.id);
    return {
      demo_status: business.demo_status ?? null,
      demo_url: business.demo_url ?? null,
      demo_preview_url: business.demo_preview_url ?? null,
      demo_sub: business.demo_sub ?? null,
      demo_built_at: business.demo_built_at ?? null,
      demo_error: business.demo_error ?? null,
      log: [...(build?.log ?? [])],
      alias_ok: build?.aliasOk ?? null,
    };
  }

  /** Test seam: wait for the business's background build to settle. */
  async settled(businessId: string): Promise<void> {
    await this.builds.get(businessId)?.done;
  }

  /**
   * Start a build in the background. Returns false when one is already
   * running for the business (the route answers 409). `ensureBrief` runs
   * first (the lead gets a Design Brief if it has none); its failure fails
   * the build at stage "brief".
   */
  start(input: {
    business: Business;
    workspaceId: string;
    sub?: string | undefined;
    ensureBrief: () => Promise<void>;
  }): boolean {
    const { business, workspaceId } = input;
    if (this.running.has(business.id)) return false;
    this.running.add(business.id);
    const state: BuildState = { log: [], aliasOk: null, done: Promise.resolve() };
    this.builds.set(business.id, state);
    state.done = this.run(input, state).finally(() => {
      this.running.delete(business.id);
    });
    return true;
  }

  private async run(
    input: { business: Business; workspaceId: string; sub?: string | undefined; ensureBrief: () => Promise<void> },
    state: BuildState,
  ): Promise<void> {
    const { business, workspaceId } = input;
    const store = this.opts.store;
    const now = this.opts.now ?? (() => new Date());
    const log = (line: string): void => {
      state.log.push(line);
      if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
      void broadcastAgentEvent(workspaceId, { type: "demo.log", businessId: business.id, line });
    };
    const fail = async (error: string): Promise<void> => {
      log(`✖ ${error}`);
      await store.updateBusiness(business.id, { demo_status: "failed", demo_error: error });
    };

    try {
      await store.updateBusiness(business.id, { demo_status: "building", demo_error: null });

      const demosDir = this.demosDir();
      if (!demosDir) {
        await fail("brief: DEMOS_DIR not configured");
        return;
      }

      log("▸ Design brief: checking");
      try {
        await input.ensureBrief();
      } catch (err) {
        await fail(`brief: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const args = ["run", "demo", "--", "--lead", business.id];
      if (input.sub) args.push("--as", input.sub);
      log(`▸ Running npm ${args.join(" ")} in ${demosDir}`);

      const outcome = await this.spawnDemo(args, demosDir, log);
      if (outcome.kind === "spawn_error") {
        await fail(`spawn: ${outcome.error}`);
        return;
      }
      if (outcome.kind === "timeout") {
        await fail(`timeout: build exceeded ${Math.round((this.opts.timeoutMs ?? DEMO_TIMEOUT_MS) / 60_000)} minutes`);
        return;
      }

      const result = parseResultLine(outcome.stdout);
      if (result?.ok === true) {
        state.aliasOk = result.aliasOk;
        await store.updateBusiness(business.id, {
          demo_status: "ready",
          demo_url: result.aliasUrl,
          demo_preview_url: result.previewUrl,
          demo_sub: result.sub,
          demo_built_at: now().toISOString(),
          demo_error: null,
        });
        log(
          `✓ Demo ready: ${result.aliasUrl}${result.aliasOk ? "" : " (public link goes live once DNS is set up)"}`,
        );
        return;
      }
      if (result?.ok === false) {
        await fail(`${result.stage}: ${result.error}`);
        return;
      }
      const lastLine = [...state.log].reverse().find((l) => !l.startsWith("▸"));
      await fail(lastLine ?? `exit code ${outcome.code ?? "unknown"} with no result line`);
    } catch (err) {
      // Never leave a business stuck in 'building' on an unexpected error.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[demo] build for ${business.id} crashed:`, err);
      try {
        await store.updateBusiness(business.id, { demo_status: "failed", demo_error: message });
      } catch (storeErr) {
        console.error("[demo] could not record the failure:", storeErr);
      }
    }
  }

  private spawnDemo(
    args: string[],
    cwd: string,
    log: (line: string) => void,
  ): Promise<
    | { kind: "closed"; code: number | null; stdout: string }
    | { kind: "timeout" }
    | { kind: "spawn_error"; error: string }
  > {
    const spawn = this.opts.spawn ?? realSpawn;
    const kill = this.opts.kill ?? killTree;
    const timeoutMs = this.opts.timeoutMs ?? DEMO_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let child: ChildLike;
      try {
        child = spawn("npm", args, { cwd });
      } catch (err) {
        resolve({ kind: "spawn_error", error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const flushErr = onLines(child.stderr, log);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill(child);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "spawn_error", error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushErr();
        resolve({ kind: "closed", code, stdout });
      });
    });
  }
}
