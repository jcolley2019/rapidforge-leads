/**
 * Dev-mode auth guard (RFL.FIX.3g, audit Part 1 #18): dev mode maps any
 * Bearer token to the dev workspace, so a production process must refuse to
 * build that handler at all.
 */
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_USER_ID, DEV_WORKSPACE_ID, MemoryStore, type DataStore } from "../store";
import { createRequireSupabaseJwt } from "./auth";

const VARS = ["NODE_ENV", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

describe("createRequireSupabaseJwt production guard (RFL.FIX.3g)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  it("the test environment itself is not production", () => {
    expect(saved.NODE_ENV).not.toBe("production");
  });

  it("production + memory store → throws at construction", () => {
    process.env.NODE_ENV = "production";
    expect(() => createRequireSupabaseJwt(new MemoryStore())).toThrow(
      /refusing to start: dev-mode auth in production/,
    );
    // Supabase env present does not rescue a memory store.
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    expect(() => createRequireSupabaseJwt(new MemoryStore())).toThrow(
      /refusing to start: dev-mode auth in production/,
    );
  });

  it("production + supabase store with env → real validation, no throw", () => {
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const supabaseStore = { mode: "supabase" } as unknown as DataStore;
    expect(() => createRequireSupabaseJwt(supabaseStore)).not.toThrow();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("production + supabase store without env → throws", () => {
    process.env.NODE_ENV = "production";
    const supabaseStore = { mode: "supabase" } as unknown as DataStore;
    expect(() => createRequireSupabaseJwt(supabaseStore)).toThrow(
      /refusing to start: dev-mode auth in production/,
    );
  });

  it("non-production + memory store → still dev mode (any Bearer → dev workspace)", async () => {
    process.env.NODE_ENV = "development";
    const handler = createRequireSupabaseJwt(new MemoryStore());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[auth] dev mode"));

    const req = { header: () => "Bearer anything" } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;
    await handler(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({ userId: DEV_USER_ID, workspaceId: DEV_WORKSPACE_ID });
  });
});
