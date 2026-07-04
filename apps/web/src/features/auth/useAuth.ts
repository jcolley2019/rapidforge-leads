import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type AuthState =
  | { status: "unconfigured" }
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signed_in"; session: Session; workspaceId: string | null };

/**
 * Session state + first-signup bootstrap.
 *
 * When Supabase env is absent the app runs in offline preview mode
 * ('unconfigured') — never crashes (Sprint 1 acceptance).
 */
export function useAuth(): { auth: AuthState; signOut: () => Promise<void> } {
  const [auth, setAuth] = useState<AuthState>(
    supabase ? { status: "loading" } : { status: "unconfigured" },
  );

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let cancelled = false;

    async function resolve(session: Session | null): Promise<void> {
      if (!client) return;
      if (!session) {
        if (!cancelled) setAuth({ status: "signed_out" });
        return;
      }
      const workspaceId = await ensureWorkspace(client);
      if (!cancelled) setAuth({ status: "signed_in", session, workspaceId });
    }

    void client.auth
      .getSession()
      .then(({ data }) => resolve(data.session));

    const { data: subscription } = client.auth.onAuthStateChange(
      (_event, session) => void resolve(session),
    );

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return {
    auth,
    signOut: async () => {
      await supabase?.auth.signOut();
    },
  };
}

/**
 * First-signup bootstrap (PRD Sprint 1): if the signed-in user has no
 * workspace membership yet, call the `bootstrap_workspace` RPC
 * (supabase/migrations/0004_rls.sql) which creates the Founder plan row,
 * the workspace, the owner membership, and workspace_config defaults.
 * Idempotent — returns the existing workspace on later sign-ins.
 */
async function ensureWorkspace(client: SupabaseClient): Promise<string | null> {
  const { data: memberships, error } = await client
    .from("workspace_members")
    .select("workspace_id")
    .limit(1);

  if (error) {
    console.error("[auth] workspace membership lookup failed:", error.message);
    return null;
  }

  const existing = memberships?.[0]?.workspace_id as string | undefined;
  if (existing) return existing;

  const { data: created, error: rpcError } = await client.rpc(
    "bootstrap_workspace",
  );
  if (rpcError) {
    console.error("[auth] bootstrap_workspace failed:", rpcError.message);
    return null;
  }
  return typeof created === "string" ? created : null;
}
