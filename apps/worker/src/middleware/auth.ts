/**
 * Supabase JWT validation middleware (PRD Section 8: worker validates
 * Supabase JWTs on its HTTP API).
 *
 * Configured mode (SUPABASE_URL + service-role key present): the Bearer
 * token is verified via supabase.auth.getUser() and the caller's
 * workspace resolved from workspace_members — 401 on a bad token, 403
 * when the user has no workspace yet.
 *
 * Dev mode (env absent — Sprint 2 modified constraint): any Bearer token
 * is accepted and the fixed dev workspace/user attached, so the full flow
 * runs with zero external services. Logged loudly at startup — and refused
 * outright when NODE_ENV=production (RFL.FIX.3g, audit Part 1 #18).
 *
 * Allowlist (RFL.SEC.1): when ALLOWED_EMAILS is set, a verified user whose
 * email is not on it gets 403. Unset = no allowlist. Dev mode has no real
 * user, so the allowlist does not apply there.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { allowedEmails } from "../lib/env";
import { DEV_USER_ID, DEV_WORKSPACE_ID, type DataStore } from "../store";

export interface AuthContext {
  userId: string;
  workspaceId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** The verified user behind a token, or null when the token is bad. */
export type VerifyToken = (
  token: string,
) => Promise<{ id: string; email?: string | null } | null>;

export interface RequireSupabaseJwtOptions {
  /** Tests only: stands in for supabase.auth.getUser (forces configured mode). */
  verifyToken?: VerifyToken;
}

export function createRequireSupabaseJwt(
  store: DataStore,
  options: RequireSupabaseJwtOptions = {},
): RequestHandler {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Dev mode follows the STORE mode: a memory store has no real workspaces,
  // so real JWT validation would reject everything (incl. the forced-memory
  // tooling stack). Supabase store + env present → real validation.
  const admin: SupabaseClient | null =
    store.mode !== "memory" && url && serviceRoleKey
      ? createClient(url, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const verifyToken: VerifyToken | null =
    options.verifyToken ??
    (admin
      ? async (token) => {
          const { data, error } = await admin.auth.getUser(token);
          return error || !data.user ? null : data.user;
        }
      : null);

  if (!verifyToken) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[auth] refusing to start: dev-mode auth in production — a memory store or missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY would map any Bearer token to the dev workspace",
      );
    }
    console.warn(
      "[auth] dev mode — Supabase env absent; any Bearer token maps to the dev workspace",
    );
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      res
        .status(401)
        .json({ error: "Missing Authorization: Bearer <supabase-jwt>" });
      return;
    }

    if (!verifyToken) {
      req.auth = { userId: DEV_USER_ID, workspaceId: DEV_WORKSPACE_ID };
      next();
      return;
    }

    try {
      const user = await verifyToken(token);
      if (!user) {
        res.status(401).json({ error: "Invalid or expired Supabase JWT" });
        return;
      }
      // Read per request: the list is tiny and a test can flip the env.
      const allowed = allowedEmails();
      if (allowed && !allowed.has((user.email ?? "").trim().toLowerCase())) {
        res.status(403).json({ error: "This account is not allowed" });
        return;
      }
      const workspaceId = await store.getWorkspaceIdForUser(user.id);
      if (!workspaceId) {
        res
          .status(403)
          .json({ error: "No workspace membership for this user" });
        return;
      }
      req.auth = { userId: user.id, workspaceId };
      next();
    } catch (err) {
      console.error("[auth] verification failed:", err);
      res.status(500).json({ error: "Auth verification failed" });
    }
  };
}
