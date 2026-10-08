import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "@rapidforge/shared";
import {
  AGENTS,
  applyAgentEvent,
  emptyLiveState,
  FEED_CAP,
  recoverFromRuns,
  isBusinessInFlight,
  latestActivityFor,
  reauditDisabled,
  reauditPhase,
  scoredRefreshKey,
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

describe("scoredRefreshKey (RFL.VERIFY.3 V6: the lists refetch on every finished audit)", () => {
  const scored = (businessId: string): AgentEvent => ({
    type: "lead.scored",
    businessId,
    healthScore: 70,
    sellabilityScore: 62,
  });

  it("is null before any lead.scored, and agent events never change it", () => {
    let state = emptyLiveState();
    expect(scoredRefreshKey(state)).toBeNull();
    state = applyAgentEvent(state, started("health", "biz-1"), 1);
    state = applyAgentEvent(state, completed("health", "biz-1"), 2);
    expect(scoredRefreshKey(state)).toBeNull();
    state = applyAgentEvent(state, scored("biz-1"), 3);
    const key = scoredRefreshKey(state);
    expect(key).not.toBeNull();
    state = applyAgentEvent(state, started("analyst", "biz-1"), 4);
    state = applyAgentEvent(state, completed("analyst", "biz-1"), 5);
    expect(scoredRefreshKey(state)).toBe(key);
  });

  it("changes on every lead.scored: a re-audit of the same business, and past FEED_CAP", () => {
    let state = applyAgentEvent(emptyLiveState(), scored("biz-landers"), 10);
    const first = scoredRefreshKey(state);
    state = applyAgentEvent(state, scored("biz-landers"), 11); // the re-audit finished
    expect(scoredRefreshKey(state)).not.toBe(first);

    const keys = new Set<string | null>();
    for (let i = 0; i < FEED_CAP + 5; i++) {
      state = applyAgentEvent(state, scored(`biz-${i % 3}`), 1000 + i);
      keys.add(scoredRefreshKey(state));
    }
    // scored.length is pinned at the cap, the key still moved every time.
    expect(state.scored).toHaveLength(FEED_CAP);
    expect(keys.size).toBe(FEED_CAP + 5);
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

// ---------------------------------------------------------------------------
// RFL.WEB.10 — per-business readings behind the Re-audit button
// ---------------------------------------------------------------------------

describe("isBusinessInFlight / latestActivityFor", () => {
  const started: AgentEvent = { type: "agent.started", agent: "health", target: "biz-1" };
  const progress: AgentEvent = {
    type: "agent.progress",
    agent: "health",
    target: "biz-1",
    message: "health running (budget 60s)",
  };
  const completed: AgentEvent = { type: "agent.completed", agent: "health", target: "biz-1", result: {} };

  it("is in flight from agent.started until that agent's completed/failed", () => {
    let state = applyAgentEvent(emptyLiveState(), started, 1000);
    expect(isBusinessInFlight(state, "biz-1")).toBe(true);
    expect(isBusinessInFlight(state, "biz-2")).toBe(false);
    state = applyAgentEvent(state, progress, 1500);
    expect(isBusinessInFlight(state, "biz-1")).toBe(true);
    expect(latestActivityFor(state, "biz-1")?.message).toBe("health running (budget 60s)");
    state = applyAgentEvent(state, completed, 2000);
    expect(isBusinessInFlight(state, "biz-1")).toBe(false);
    expect(latestActivityFor(state, "biz-1")?.kind).toBe("agent.completed");
  });

  it("stays in flight while ANY agent for the business is still running", () => {
    let state = applyAgentEvent(emptyLiveState(), started, 1000);
    state = applyAgentEvent(state, { type: "agent.started", agent: "seo", target: "biz-1" }, 1000);
    state = applyAgentEvent(state, completed, 2000);
    expect(isBusinessInFlight(state, "biz-1")).toBe(true);
    state = applyAgentEvent(state, { type: "agent.failed", agent: "seo", target: "biz-1", error: "x" }, 2100);
    expect(isBusinessInFlight(state, "biz-1")).toBe(false);
  });

  it("a business id that is a suffix of another never matches", () => {
    const state = applyAgentEvent(emptyLiveState(), { ...started, target: "xbiz-1" }, 1000);
    expect(isBusinessInFlight(state, "biz-1")).toBe(false);
  });

  it("recovered running runs count as in flight after a reload", () => {
    const run = {
      id: "run-1",
      workspace_id: "w",
      agent_name: "health",
      job_id: "j",
      target_id: "biz-1",
      status: "running",
      input: null,
      output: null,
      error: null,
      model_used: null,
      tokens_used: 0,
      cost_cents: 0,
      guardrail_passed: true,
      guardrail_notes: null,
      duration_ms: null,
      started_at: "2026-10-05T10:00:00.000Z",
      ended_at: null,
    } as AgentRun;
    let state = recoverFromRuns([run]);
    expect(isBusinessInFlight(state, "biz-1")).toBe(true);
    state = applyAgentEvent(state, completed, Date.parse("2026-10-05T10:00:05.000Z"));
    expect(isBusinessInFlight(state, "biz-1")).toBe(false);
    expect(state.statuses.health?.avgRuntimeMs).toBe(5000);
  });
});

describe("reauditPhase (button disabled while a job is queued/running)", () => {
  it("idle → queued on click → running on events → done when they stop", () => {
    expect(reauditPhase({ requested: false, seenRunning: false, inFlight: false })).toBe("idle");
    expect(reauditPhase({ requested: true, seenRunning: false, inFlight: false })).toBe("queued");
    expect(reauditPhase({ requested: true, seenRunning: true, inFlight: true })).toBe("running");
    expect(reauditPhase({ requested: true, seenRunning: true, inFlight: false })).toBe("done");
  });

  it("running even when someone else queued the job (bulk re-audit, another tab)", () => {
    expect(reauditPhase({ requested: false, seenRunning: false, inFlight: true })).toBe("running");
  });

  it("is disabled exactly while queued or running", () => {
    expect(reauditDisabled("idle")).toBe(false);
    expect(reauditDisabled("queued")).toBe(true);
    expect(reauditDisabled("running")).toBe(true);
    expect(reauditDisabled("done")).toBe(false);
  });
});
