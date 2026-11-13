/**
 * Dev-mode auth guard (RFL.FIX.3g, audit Part 1 #18): dev mode maps any
 * Bearer token to the dev workspace, so a production process must refuse to
 * build that handler at all.
 */
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_USER_ID, DEV_WORKSPACE_ID, MemoryStore, type DataStore } from "../store";
import { createRequireSupabaseJwt } from "./auth";

const VARS = ["NODE_ENV", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_EMAILS"] as const;

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

describe("ALLOWED_EMAILS allowlist (RFL.SEC.1)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  const WORKSPACE = "11111111-1111-4111-8111-111111111111";
  const store = {
    mode: "supabase",
    getWorkspaceIdForUser: async () => WORKSPACE,
  } as unknown as DataStore;

  /** Run the middleware for a token that verifies as `email`. */
  async function call(email: string | null | undefined, token = "good") {
    const handler = createRequireSupabaseJwt(store, {
      verifyToken: async (t) => (t === "good" ? { id: "user-1", email } : null),
    });
    const req = { header: () => `Bearer ${token}` } as unknown as Request;
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        out.status = code;
        return this;
      },
      json(body: unknown) {
        out.body = body;
        return this;
      },
    } as unknown as Response;
    const next = vi.fn();
    await handler(req, res, next as unknown as NextFunction);
    return { req, out, next };
  }

  it("unset → any verified user passes (today's behavior)", async () => {
    const { req, next } = await call("stranger@example.com");
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({ userId: "user-1", workspaceId: WORKSPACE });
  });

  it("blank or commas only counts as unset", async () => {
    process.env.ALLOWED_EMAILS = " , ,";
    const { next } = await call("stranger@example.com");
    expect(next).toHaveBeenCalledOnce();
  });

  it("a listed email passes", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com,partner@example.com";
    const { req, next } = await call("partner@example.com");
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth?.workspaceId).toBe(WORKSPACE);
  });

  it("an unlisted email gets 403 and never reaches the route", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com";
    const { req, out, next } = await call("stranger@example.com");
    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "This account is not allowed" });
    expect(req.auth).toBeUndefined();
  });

  it("a user with no email gets 403 when the list is set", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com";
    for (const email of [null, undefined, ""]) {
      const { out, next } = await call(email);
      expect(next).not.toHaveBeenCalled();
      expect(out.status).toBe(403);
    }
  });

  it("letter case and spaces are ignored on both sides", async () => {
    process.env.ALLOWED_EMAILS = "  Owner@Example.COM ,  partner@example.com  ";
    expect((await call("owner@example.com")).next).toHaveBeenCalledOnce();
    expect((await call("OWNER@EXAMPLE.com")).next).toHaveBeenCalledOnce();
    expect((await call(" Partner@Example.com ")).next).toHaveBeenCalledOnce();
  });

  it("a bad token is still 401, listed or not", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com";
    const { out, next } = await call("owner@example.com", "garbage");
    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(401);
  });
});
