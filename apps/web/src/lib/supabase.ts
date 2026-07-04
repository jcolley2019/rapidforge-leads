/**
 * Supabase browser client — anon key + RLS ONLY (CLAUDE.md Section 1).
 * Zero secrets: nothing beyond VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * may ever reach this app (PRD Section 9).
 *
 * When env vars are absent (fresh clone), the client is null and the app
 * runs in offline preview mode instead of crashing — Sprint 1 acceptance.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const isSupabaseConfigured = supabase !== null;
