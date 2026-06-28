/**
 * comm-channel-p2p — a real point-to-point ICommChannel over the daemon transport.
 *
 * Verifies: the channel registers via hooks.commChannels; send() routes through the
 * DAEMON_COMM service (real transport); onMessage() fires when the daemon feeds an
 * inbound message via deliverInbound; reply() routes through DAEMON_COMM.reply; and
 * outside daemon mode (service absent) send/reply throw.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  IPluginContext,
  IPluginService,
  IDaemonCommService,
  ICommChannel,
  CommMessage,
} from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";
import { createCommChannelP2pPlugin, DaemonP2PChannel } from "./index.js";

function fullCommService(overrides: Partial<IDaemonCommService> = {}): IDaemonCommService {
  return {
    name: "daemon-comm",
    version: "1.0.0",
    send: vi.fn(async () => ({ delivered: true, messageId: "m-1" })),
    readInbox: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({ subscribed: true })),
    readEvents: vi.fn(async () => []),
    registerService: vi.fn(async () => ({ registered: true })),
    findPeer: vi.fn(async () => []),
    request: vi.fn(async () => ({ id: "r", timestamp: 1, source: "b", target: "a", payload: {} } as CommMessage)),
    reply: vi.fn(async () => ({ delivered: true, messageId: "rep-1" })),
    broadcast: vi.fn(async () => []),
    pipeline: vi.fn(async () => ({ delivered: true, pipelineId: "p", firstHop: "b" })),
    ...overrides,
  };
}

function makeCtx(commService: IDaemonCommService | null): IPluginContext {
  const services = {
    get<T extends IPluginService>(key: { name: string }): T | undefined {
      if (commService && key.name === SERVICE_KEYS.DAEMON_COMM.name) return commService as unknown as T;
      return undefined;
    },
    has: (key: { name: string }) => commService !== null && key.name === SERVICE_KEYS.DAEMON_COMM.name,
    register: () => {},
    list: () => (commService ? [commService] : []),
    unregister: () => false,
  };
  return { services } as unknown as IPluginContext;
}

function msg(overrides: Partial<CommMessage> = {}): CommMessage {
  return {
    id: "m-1", timestamp: 1, source: "agent-a", target: "agent-b",
    payload: { hi: 1 }, performative: "inform", ...overrides,
  } as CommMessage;
}

async function getChannel(ctx: IPluginContext): Promise<ICommChannel & { deliverInbound: (m: CommMessage, f: string) => void; getReceived: () => CommMessage[] }> {
  const hooks = await createCommChannelP2pPlugin().factory(ctx);
  const ch = (hooks.commChannels ?? [])[0];
  expect(ch).toBeDefined();
  return ch as ICommChannel & { deliverInbound: (m: CommMessage, f: string) => void; getReceived: () => CommMessage[] };
}

describe("comm-channel-p2p plugin", () => {
  it("registers one messaging point-to-point channel via hooks.commChannels", async () => {
    const hooks = await createCommChannelP2pPlugin().factory(makeCtx(fullCommService()));
    expect(hooks.commChannels?.length).toBe(1);
    const ch = hooks.commChannels![0];
    expect(ch.name).toBe("p2p");
    expect(ch.topology).toBe("point-to-point");
    expect(ch.capabilities).toContain("messaging");
  });

  it("manifest declares skandha rupa (色蘊 — ICommChannel)", () => {
    expect(createCommChannelP2pPlugin().manifest.skandha).toBe("rupa");
  });
});

describe("DaemonP2PChannel.send (real transport via DAEMON_COMM)", () => {
  it("connected: routes send through DAEMON_COMM.send", async () => {
    const svc = fullCommService();
    const ch = await getChannel(makeCtx(svc));
    await ch.connect();
    expect(ch.getStatus()).toBe("connected");
    await ch.send!("agent-b", msg({ payload: { q: 1 }, performative: "request" }));
    expect(svc.send).toHaveBeenCalledWith({ target: "agent-b", payload: { q: 1 }, performative: "request" });
  });

  it("not connected: send throws (lifecycle gate)", async () => {
    const ch = await getChannel(makeCtx(fullCommService()));
    await expect(ch.send!("agent-b", msg())).rejects.toThrow(/not connected/);
  });

  it("no daemon: send throws a clear daemon-only error", async () => {
    const ch = await getChannel(makeCtx(null));
    await ch.connect();
    await expect(ch.send!("agent-b", msg())).rejects.toThrow(/daemon mode only/);
  });
});

describe("DaemonP2PChannel.onMessage / deliverInbound (real inbound)", () => {
  it("invokes registered handlers + records received; unsubscribe works", async () => {
    const ch = await getChannel(makeCtx(fullCommService()));
    const seen: Array<{ m: CommMessage; from: string }> = [];
    const unsub = ch.onMessage!((m, from) => seen.push({ m, from }));

    ch.deliverInbound(msg({ id: "x1", source: "agent-a" }), "agent-a");
    expect(seen.length).toBe(1);
    expect(seen[0].from).toBe("agent-a");
    expect(seen[0].m.id).toBe("x1");
    expect(ch.getReceived().map((m) => m.id)).toEqual(["x1"]);

    unsub();
    ch.deliverInbound(msg({ id: "x2" }), "agent-a");
    expect(seen.length).toBe(1); // no longer invoked after unsubscribe
    expect(ch.getReceived().map((m) => m.id)).toEqual(["x1", "x2"]); // still recorded
  });

  it("a throwing handler does not break delivery to others", async () => {
    const ch = await getChannel(makeCtx(fullCommService()));
    const ok: string[] = [];
    ch.onMessage!(() => { throw new Error("boom"); });
    ch.onMessage!((m) => ok.push(m.id));
    ch.deliverInbound(msg({ id: "y1" }), "agent-a");
    expect(ok).toEqual(["y1"]);
  });
});

describe("DaemonP2PChannel.reply", () => {
  it("routes reply through DAEMON_COMM.reply", async () => {
    const svc = fullCommService();
    const ch = await getChannel(makeCtx(svc));
    await ch.reply!("req-1", msg({ target: "agent-a", payload: { ok: true } }));
    expect(svc.reply).toHaveBeenCalledWith("agent-a", "req-1", { ok: true });
  });

  it("no daemon: reply throws", async () => {
    const ch = await getChannel(makeCtx(null));
    await expect(ch.reply!("req-1", msg({ target: "agent-a" }))).rejects.toThrow(/daemon mode only/);
  });
});
