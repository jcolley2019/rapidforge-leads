/**
 * DataStore selector (Sprint 2 modified constraint): SupabaseStore when
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, MemoryStore otherwise.
 * The worker logs which mode it is in at startup.
 */
import { MemoryStore } from "./memory";
import { SupabaseStore } from "./supabase";
import type { DataStore } from "./types";

export * from "./types";
export { MemoryStore } from "./memory";
export { SupabaseStore } from "./supabase";

export function createDataStore(): DataStore {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceRoleKey) {
    console.log("[store] mode: supabase (service-role)");
    return new SupabaseStore(url, serviceRoleKey);
  }
  console.log(
    "[store] mode: memory — SUPABASE_URL absent; data lives for this process only",
  );
  return new MemoryStore();
}
