/**
 * Workspace Realtime subscription (PRD 5.6) — web side.
 *
 * Subscribes to broadcast `agent_event` on `workspace:{id}`, Zod-validates
 * every payload, and resubscribes with capped exponential backoff when the
 * channel errors or times out. Written against a minimal structural client
 * so the whole lifecycle is unit-testable without supabase-js.
 */
import {
  AgentEventSchema,
  workspaceChannel,
  type AgentEvent,
} from "@rapidforge/shared";
import type { ConnectionState } from "@/lib/agent-state";

/** Matches the worker's broadcast event name (apps/worker/src/events.ts). */
export const AGENT_EVENT = "agent_event";

/** Structural slice of RealtimeChannel that we use. */
export interface ChannelLike {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): ChannelLike;
  subscribe(callback: (status: string) => void): ChannelLike;
}

/** Structural slice of SupabaseClient that we use. */
export interface RealtimeClientLike {
  channel(name: string): ChannelLike;
  removeChannel(channel: ChannelLike): unknown;
}

export interface SubscribeOptions {
  onEvent: (event: AgentEvent) => void;
  onConnection: (state: ConnectionState) => void;
  /** Backoff base in ms (default 1000); doubles per retry, capped 15s. */
  backoffBaseMs?: number;
}

export interface RealtimeHandle {
  dispose(): void;
}

export const BACKOFF_CAP_MS = 15_000;

export function subscribeToWorkspace(
  client: RealtimeClientLike,
  workspaceId: string,
  options: SubscribeOptions,
): RealtimeHandle {
  const { onEvent, onConnection, backoffBaseMs = 1000 } = options;
  let disposed = false;
  let channel: ChannelLike | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (disposed) return;
    onConnection(retries === 0 ? "connecting" : "reconnecting");
    channel = client
      .channel(workspaceChannel(workspaceId))
      .on("broadcast", { event: AGENT_EVENT }, (message) => {
        const parsed = AgentEventSchema.safeParse(message.payload);
        if (parsed.success) {
          // zod's z.unknown() infers `result` as an optional KEY, while the
          // hand-written AgentEvent keeps it required — same runtime shape.
          onEvent(parsed.data as AgentEvent);
        } else {
          console.warn("[realtime] dropped malformed agent event", message);
        }
      })
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          retries = 0;
          onConnection("live");
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          scheduleReconnect();
        }
      });
  }

  function scheduleReconnect(): void {
    if (disposed || retryTimer) return;
    onConnection("reconnecting");
    const delay = Math.min(backoffBaseMs * 2 ** retries, BACKOFF_CAP_MS);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (channel) client.removeChannel(channel);
      channel = null;
      connect();
    }, delay);
  }

  connect();

  return {
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (channel) client.removeChannel(channel);
      channel = null;
    },
  };
}
