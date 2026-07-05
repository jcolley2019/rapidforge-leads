/**
 * Supabase browser client — anon key + RLS ONLY (CLAUDE.md Section 1).
 * Zero secrets: nothing beyond VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * may ever reach this app (PRD Section 9).
 *
 * When env vars are absent (fresh clone), the client is null and the app
 * runs in offline preview mode instead of crashing — Sprint 1 acceptance.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// trim() so whitespace-only values (e.g. a tooling stack disabling Supabase
// via env override) fall back to offline preview instead of crashing
// createClient with an invalid URL.
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const isSupabaseConfigured = supabase !== null;
