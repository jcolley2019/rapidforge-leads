import type { NextFunction, Request, Response } from "express";

/**
 * Supabase JWT validation middleware — Sprint 1 STUB.
 *
 * Sprint 1 behavior: requires a Bearer token to be present, nothing more.
 * TODO(Sprint 2): verify the JWT properly (signature via the project's JWT
 * secret or JWKS, `exp`, `aud`), attach user id + workspace membership to
 * the request, and reject with 401/403 accordingly.
 */
export function requireSupabaseJwt(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <supabase-jwt>" });
    return;
  }

  // TODO(Sprint 2): real verification — presence-only until then.
  next();
}
