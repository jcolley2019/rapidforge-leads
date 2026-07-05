/**
 * useWorkspaceLive — one Realtime subscription per signed-in session
 * (PRD 5.6: "frontend subscribes on login").
 *
 * Boot order: subscribe first (events buffer), recover state from
 * agent_runs, then flush the buffer over the recovered state — no missed
 * or double-counted events across a reload. Polling in the views stays as
 * the data fallback; this hook only powers live status/feed UI.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AgentRunSchema, type AgentEvent } from "@rapidforge/shared";
import {
  applyAgentEvent,
  emptyLiveState,
  recoverFromRuns,
  type ConnectionState,
  type WorkspaceLive,
} from "@/lib/agent-state";
import { subscribeToWorkspace, type RealtimeClientLike } from "@/lib/realtime";
import { supabase } from "@/lib/supabase";

/** How many recent agent_runs to replay on reload. */
export const RECOVERY_ROWS = 300;

export interface LiveValue {
  live: WorkspaceLive;
  connection: ConnectionState;
}

export function useWorkspaceLive(workspaceId: string | null): LiveValue {
  const [live, setLive] = useState<WorkspaceLive>(emptyLiveState);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  // Buffer live events until agent_runs recovery lands.
  const recovered = useRef(false);
  const buffer = useRef<AgentEvent[]>([]);

  useEffect(() => {
    if (!supabase || !workspaceId) return;
    recovered.current = false;
    buffer.current = [];
    setLive(emptyLiveState());

    const handle = subscribeToWorkspace(
      supabase as unknown as RealtimeClientLike,
      workspaceId,
      {
        onEvent(event) {
          if (!recovered.current) {
            buffer.current.push(event);
            return;
          }
          setLive((state) => applyAgentEvent(state, event));
        },
        onConnection: setConnection,
      },
    );

    void supabase
      .from("agent_runs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("started_at", { ascending: false })
      .limit(RECOVERY_ROWS)
      .then(({ data, error }) => {
        const runs = error
          ? []
          : (data ?? []).flatMap((row) => {
              const parsed = AgentRunSchema.safeParse(row);
              return parsed.success ? [parsed.data] : [];
            });
        if (error) {
          console.warn("[live] agent_runs recovery failed:", error.message);
        }
        let state = recoverFromRuns(runs);
        for (const event of buffer.current) {
          state = applyAgentEvent(state, event);
        }
        buffer.current = [];
        recovered.current = true;
        setLive(state);
      });

    return () => handle.dispose();
  }, [workspaceId]);

  return { live, connection };
}

export const LiveContext = createContext<LiveValue>({
  live: emptyLiveState(),
  connection: "connecting",
});

export function useLive(): LiveValue {
  return useContext(LiveContext);
}
