/**
 * Realtime event broadcasting (PRD 5.6) — Sprint 4, real implementation.
 *
 * The worker broadcasts AgentEvents on channel `workspace:{id}` with the
 * service-role key. Sending happens over Supabase's REST broadcast endpoint
 * (channel.send() on an unsubscribed channel), so the worker holds no
 * websocket and needs no reconnect logic — each event is one stateless POST.
 * The web app subscribes over websocket and recovers missed state from
 * `agent_runs` on reload; polling GET /api/searches/:id stays the fallback.
 *
 * Graceful no-op without Supabase env (Sprint 1 acceptance) and on the
 * forced-memory tooling stack (fully offline — no stray broadcasts).
 */
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { workspaceChannel, type AgentEvent } from "@rapidforge/shared";

/** Broadcast event name on the workspace channel (web listens for this). */
export const AGENT_EVENT = "agent_event";

let client: SupabaseClient | null | undefined;
const channels = new Map<string, RealtimeChannel>();

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const offline = process.env.RAPIDFORGE_FORCE_MEMORY_STORE === "true";
  if (!url || !key || offline) {
    client = null;
    console.log(
      `[events] mode: stub — ${offline ? "forced-memory tooling stack" : "Supabase env absent"}; events logged only`,
    );
  } else {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("[events] mode: realtime (supabase broadcast)");
  }
  return client;
}

function getChannel(workspaceId: string): RealtimeChannel | null {
  const supabase = getClient();
  if (!supabase) return null;
  const name = workspaceChannel(workspaceId);
  let channel = channels.get(name);
  if (!channel) {
    // Deliberately NOT subscribed: send() on an unjoined channel posts via
    // the REST broadcast endpoint instead of the socket.
    channel = supabase.channel(name);
    channels.set(name, channel);
  }
  return channel;
}

export async function broadcastAgentEvent(
  workspaceId: string,
  event: AgentEvent,
): Promise<void> {
  const channel = getChannel(workspaceId);
  if (!channel) {
    console.log(
      `[events] (stub) ${workspaceChannel(workspaceId)} → ${event.type}`,
    );
    return;
  }
  try {
    const result = await channel.send({
      type: "broadcast",
      event: AGENT_EVENT,
      payload: event,
    });
    if (result !== "ok") {
      console.warn(
        `[events] broadcast '${event.type}' to ${workspaceChannel(workspaceId)} returned: ${result}`,
      );
    }
  } catch (err) {
    // Events are best-effort — a Realtime hiccup must never fail a job
    // (the web recovers from agent_runs / polling).
    console.warn(
      `[events] broadcast '${event.type}' failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Test seam: reset module state between tests. */
export function __resetEventsForTests(): void {
  client = undefined;
  channels.clear();
}
