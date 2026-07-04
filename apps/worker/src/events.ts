/**
 * Realtime event broadcasting (PRD 5.6).
 *
 * The worker broadcasts AgentEvents on channel `workspace:{id}` using the
 * service-role key. Sprint 1: console stub that no-ops without env —
 * agents can call this from day one without crashing dev.
 *
 * TODO(Sprint 4): real supabase-js Realtime broadcast + persistence
 * contract with agent_runs so page reloads recover live state.
 */
import { workspaceChannel, type AgentEvent } from "@rapidforge/shared";

export async function broadcastAgentEvent(
  workspaceId: string,
  event: AgentEvent,
): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return; // graceful no-op without env (Sprint 1 acceptance)
  }
  // TODO(Sprint 4): supabase.channel(workspaceChannel(workspaceId)).send(...)
  console.log(`[events] (stub) ${workspaceChannel(workspaceId)} → ${event.type}`);
}
