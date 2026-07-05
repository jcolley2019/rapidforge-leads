import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@rapidforge/shared";
import {
  subscribeToWorkspace,
  type ChannelLike,
  type RealtimeClientLike,
} from "./realtime";

/** Fake channel that lets tests drive broadcasts and status changes. */
class FakeChannel implements ChannelLike {
  broadcastCb: ((message: { payload?: unknown }) => void) | null = null;
  statusCb: ((status: string) => void) | null = null;
  on(
    _type: "broadcast",
    _filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): ChannelLike {
    this.broadcastCb = callback;
    return this;
  }
  subscribe(callback: (status: string) => void): ChannelLike {
    this.statusCb = callback;
    return this;
  }
}

class FakeClient implements RealtimeClientLike {
  channels: FakeChannel[] = [];
  removed: ChannelLike[] = [];
  names: string[] = [];
  channel(name: string): ChannelLike {
    this.names.push(name);
    const ch = new FakeChannel();
    this.channels.push(ch);
    return ch;
  }
  removeChannel(channel: ChannelLike): unknown {
    this.removed.push(channel);
    return "ok";
  }
}

const VALID: AgentEvent = { type: "agent.started", agent: "scout" };

describe("subscribeToWorkspace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes on workspace:{id} and reports live on SUBSCRIBED", () => {
    const client = new FakeClient();
    const states: string[] = [];
    subscribeToWorkspace(client, "ws-1", {
      onEvent: () => {},
      onConnection: (s) => states.push(s),
    });
    expect(client.names).toEqual(["workspace:ws-1"]);
    client.channels[0]!.statusCb?.("SUBSCRIBED");
    expect(states).toEqual(["connecting", "live"]);
  });

  it("delivers valid payloads and drops malformed ones", () => {
    const client = new FakeClient();
    const events: AgentEvent[] = [];
    subscribeToWorkspace(client, "ws-1", {
      onEvent: (e) => events.push(e),
      onConnection: () => {},
    });
    client.channels[0]!.broadcastCb?.({ payload: VALID });
    client.channels[0]!.broadcastCb?.({ payload: { type: "nonsense" } });
    client.channels[0]!.broadcastCb?.({});
    expect(events).toEqual([VALID]);
  });

  it("resubscribes with backoff after CHANNEL_ERROR and recovers", () => {
    const client = new FakeClient();
    const states: string[] = [];
    subscribeToWorkspace(client, "ws-1", {
      onEvent: () => {},
      onConnection: (s) => states.push(s),
      backoffBaseMs: 1000,
    });
    client.channels[0]!.statusCb?.("SUBSCRIBED");
    client.channels[0]!.statusCb?.("CHANNEL_ERROR");
    expect(states).toEqual(["connecting", "live", "reconnecting"]);

    vi.advanceTimersByTime(1000);
    expect(client.channels).toHaveLength(2);
    expect(client.removed).toHaveLength(1);
    client.channels[1]!.statusCb?.("SUBSCRIBED");
    expect(states.at(-1)).toBe("live");
  });

  it("backs off exponentially across consecutive failures", () => {
    const client = new FakeClient();
    subscribeToWorkspace(client, "ws-1", {
      onEvent: () => {},
      onConnection: () => {},
      backoffBaseMs: 1000,
    });
    client.channels[0]!.statusCb?.("TIMED_OUT");
    vi.advanceTimersByTime(1000); // retry 1 after 1s
    expect(client.channels).toHaveLength(2);
    client.channels[1]!.statusCb?.("TIMED_OUT");
    vi.advanceTimersByTime(1000); // 2nd retry needs 2s
    expect(client.channels).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(client.channels).toHaveLength(3);
  });

  it("dispose removes the channel and cancels pending retries", () => {
    const client = new FakeClient();
    const handle = subscribeToWorkspace(client, "ws-1", {
      onEvent: () => {},
      onConnection: () => {},
    });
    client.channels[0]!.statusCb?.("CHANNEL_ERROR");
    handle.dispose();
    vi.advanceTimersByTime(60_000);
    expect(client.channels).toHaveLength(1);
    expect(client.removed).toHaveLength(1);
  });
});
