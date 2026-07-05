/**
 * events.ts — Sprint 4 realtime broadcast seam.
 * The Supabase client is mocked; these tests pin the seam behavior:
 * stub without env, REST-style send with env, best-effort error handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
const channelMock = vi.fn(() => ({ send: sendMock }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ channel: channelMock })),
}));

import { createClient } from "@supabase/supabase-js";
import { __resetEventsForTests, broadcastAgentEvent } from "./events";

const EVENT = { type: "agent.started", agent: "scout" } as const;

describe("broadcastAgentEvent", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    __resetEventsForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = env;
  });

  it("no-ops without Supabase env (stub mode)", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await broadcastAgentEvent("ws-1", EVENT);
    expect(createClient).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no-ops on the forced-memory tooling stack even with env", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
    process.env.RAPIDFORGE_FORCE_MEMORY_STORE = "true";
    await broadcastAgentEvent("ws-1", EVENT);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("broadcasts on workspace:{id} with the agent_event name", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
    delete process.env.RAPIDFORGE_FORCE_MEMORY_STORE;
    await broadcastAgentEvent("ws-1", EVENT);
    expect(channelMock).toHaveBeenCalledWith("workspace:ws-1");
    expect(sendMock).toHaveBeenCalledWith({
      type: "broadcast",
      event: "agent_event",
      payload: EVENT,
    });
  });

  it("reuses one channel per workspace", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
    delete process.env.RAPIDFORGE_FORCE_MEMORY_STORE;
    await broadcastAgentEvent("ws-1", EVENT);
    await broadcastAgentEvent("ws-1", EVENT);
    await broadcastAgentEvent("ws-2", EVENT);
    expect(channelMock).toHaveBeenCalledTimes(2);
  });

  it("never throws when send rejects (events are best-effort)", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
    delete process.env.RAPIDFORGE_FORCE_MEMORY_STORE;
    sendMock.mockRejectedValueOnce(new Error("socket down"));
    await expect(broadcastAgentEvent("ws-1", EVENT)).resolves.toBeUndefined();
  });
});
