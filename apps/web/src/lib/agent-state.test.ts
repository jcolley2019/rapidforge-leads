import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "@rapidforge/shared";
import {
  AGENTS,
  applyAgentEvent,
  emptyLiveState,
  FEED_CAP,
  recoverFromRuns,
} from "./agent-state";

const started = (agent: string, target?: string): AgentEvent => ({
  type: "agent.started",
  agent,
  ...(target ? { target } : {}),
});
const completed = (agent: string, target?: string): AgentEvent => ({
  type: "agent.completed",
  agent,
  result: {},
  ...(target ? { target } : {}),
});

function makeRun(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    agent_name: "health",
    job_id: null,
    target_id: null,
    status: "completed",
    input: null,
    output: null,
    error: null,
    model_used: null,
    tokens_used: 0,
    cost_cents: 0,
    guardrail_passed: null,
    guardrail_notes: null,
    duration_ms: 1000,
    started_at: "2026-07-05T20:00:00Z",
    ended_at: "2026-07-05T20:00:01Z",
    ...overrides,
  };
}

describe("applyAgentEvent", () => {
  it("seeds all seven v1 agents as idle", () => {
    const state = emptyLiveState();
    expect(Object.keys(state.statuses)).toEqual([...AGENTS]);
    expect(state.statuses.scout!.state).toBe("idle");
  });

  it("started → working with target; completed → idle with done count", () => {
    let state = emptyLiveState();
    state = applyAgentEvent(state, started("health", "biz-1"), 1_000);
    expect(state.statuses.health!.state).toBe("working");
    expect(state.statuses.health!.currentTarget).toBe("biz-1");
    expect(state.statuses.health!.inFlight).toBe(1);

    state = applyAgentEvent(state, completed("health", "biz-1"), 3_500);
    expect(state.statuses.health!.state).toBe("idle");
    expect(state.statuses.health!.currentTarget).toBeNull();
    expect(state.statuses.health!.done).toBe(1);
    expect(state.statuses.health!.avgRuntimeMs).toBe(2_500);
  });

  it("stays working while other runs are in flight; averages runtimes", () => {
    let state = emptyLiveState();
    state = applyAgentEvent(state, started("health", "a"), 0);
    state = applyAgentEvent(state, started("health", "b"), 0);
    state = applyAgentEvent(state, completed("health", "a"), 1_000);
    expect(state.statuses.health!.state).toBe("working");
    state = applyAgentEvent(state, completed("health", "b"), 3_000);
    expect(state.statuses.health!.state).toBe("idle");
    expect(state.statuses.health!.avgRuntimeMs).toBe(2_000);
  });

  it("failed increments failed and records the error in the feed", () => {
    let state = emptyLiveState();
    state = applyAgentEvent(state, started("psi", "x"), 0);
    state = applyAgentEvent(
      state,
      { type: "agent.failed", agent: "psi", target: "x", error: "boom" },
      100,
    );
    expect(state.statuses.psi!.failed).toBe(1);
    expect(state.feed[0]!.message).toBe("boom");
  });

  it("lead.scored lands in scored, not the agent feed", () => {
    const state = applyAgentEvent(
      emptyLiveState(),
      {
        type: "lead.scored",
        businessId: "biz-9",
        healthScore: 36,
        sellabilityScore: 82,
      },
      42,
    );
    expect(state.scored).toEqual([
      { businessId: "biz-9", healthScore: 36, sellabilityScore: 82, at: 42 },
    ]);
    expect(state.feed).toHaveLength(0);
  });

  it("caps the feed at FEED_CAP", () => {
    let state = emptyLiveState();
    for (let i = 0; i < FEED_CAP + 25; i++) {
      state = applyAgentEvent(state, started("scout"), i);
    }
    expect(state.feed).toHaveLength(FEED_CAP);
  });
});

describe("recoverFromRuns", () => {
  it("rebuilds working state from running rows and stats from settled rows", () => {
    const runs: AgentRun[] = [
      makeRun({ agent_name: "conversion", status: "running", target_id: "b2", duration_ms: null, ended_at: null }),
      makeRun({ agent_name: "health", status: "completed", duration_ms: 2_000 }),
      makeRun({ agent_name: "health", status: "completed", duration_ms: 4_000 }),
      makeRun({ agent_name: "health", status: "failed", duration_ms: null }),
    ];
    const state = recoverFromRuns(runs);
    expect(state.statuses.conversion!.state).toBe("working");
    expect(state.statuses.conversion!.currentTarget).toBe("b2");
    expect(state.statuses.health!.done).toBe(2);
    expect(state.statuses.health!.failed).toBe(1);
    expect(state.statuses.health!.avgRuntimeMs).toBe(3_000);
    expect(state.feed.length).toBe(4);
  });

  it("live events replay cleanly on top of a recovered state", () => {
    let state = recoverFromRuns([
      makeRun({ agent_name: "scorer", status: "completed", duration_ms: 500 }),
    ]);
    state = applyAgentEvent(state, started("scorer", "b1"), 10_000);
    state = applyAgentEvent(state, completed("scorer", "b1"), 10_500);
    expect(state.statuses.scorer!.done).toBe(2);
    expect(state.statuses.scorer!.avgRuntimeMs).toBe(500);
  });
});
