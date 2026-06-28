/**
 * agent-comm (Tenet #10 / Fractal Society C/T1+T2): the `agent.send`,
 * `agent.inbox`, `agent.subscribe`, `agent.events` ITool behavior.
 *
 * Verifies the tools consume SERVICE_KEYS.DAEMON_COMM and behave correctly in
 * three cases: daemon present (operation succeeds), denial (the reason is
 * surfaced to the model), and no daemon (clear daemon-only message). No
 * exceptions are thrown out of execute().
 */

import { describe, it, expect, vi } from "vitest";
import type {
  IPluginContext,
  IPluginService,
  IDaemonCommService,
  ITool,
  CommMessage,
} from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";
import { createAgentCommPlugin } from "./index.js";

type AnyTool = ITool<Record<string, unknown>>;

/** A complete IDaemonCommService with vi.fn defaults, overridable per test. */
function fullService(overrides: Partial<IDaemonCommService> = {}): IDaemonCommService {
  return {
    name: "daemon-comm",
    version: "1.0.0",
    send: vi.fn(async () => ({ delivered: true, messageId: "m-1" })),
    readInbox: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({ subscribed: true })),
    readEvents: vi.fn(async () => []),
    registerService: vi.fn(async () => ({ registered: true })),
    findPeer: vi.fn(async () => []),
    request: vi.fn(async () => ({
      id: "rep-1", timestamp: 1, source: "agent-b", target: "agent-a",
      payload: { ack: true }, performative: "inform",
    } as CommMessage)),
    reply: vi.fn(async () => ({ delivered: true, messageId: "r-1" })),
    broadcast: vi.fn(async () => []),
    pipeline: vi.fn(async () => ({ delivered: true, pipelineId: "p-1", firstHop: "agent-b" })),
    ...overrides,
  };
}

/** Build a plugin context whose service registry returns `commService` for the
 *  DAEMON_COMM key (or nothing when null = non-daemon mode). */
function makeCtx(commService: IDaemonCommService | null): IPluginContext {
  const services = {
    get<T extends IPluginService>(key: { name: string }): T | undefined {
      if (commService && key.name === SERVICE_KEYS.DAEMON_COMM.name) {
        return commService as unknown as T;
      }
      return undefined;
    },
    has: (key: { name: string }) => commService !== null && key.name === SERVICE_KEYS.DAEMON_COMM.name,
    register: () => {},
    list: () => (commService ? [commService] : []),
    unregister: () => false,
  };
  return { services } as unknown as IPluginContext;
}

async function getTool(ctx: IPluginContext, id: string): Promise<AnyTool> {
  const hooks = await createAgentCommPlugin().factory(ctx);
  const tool = (hooks.tools ?? []).find((t) => t.id === id) as unknown as AnyTool;
  expect(tool).toBeDefined();
  expect(tool.skandha).toBe("samskara");
  return tool;
}

const TOOLCTX = {} as never;

function makeMessage(overrides: Partial<CommMessage> = {}): CommMessage {
  return {
    id: "m-1",
    timestamp: 1_700_000_000_000,
    source: "agent-a",
    target: "agent-b",
    payload: { hello: "world" },
    performative: "inform",
    ...overrides,
  } as CommMessage;
}

describe("agent-comm plugin surface", () => {
  it("exposes exactly the ten cross-daemon tools", async () => {
    const hooks = await createAgentCommPlugin().factory(makeCtx(fullService()));
    const ids = (hooks.tools ?? []).map((t) => t.id).sort();
    expect(ids).toEqual([
      "agent.broadcast",
      "agent.events",
      "agent.findPeer",
      "agent.inbox",
      "agent.pipeline",
      "agent.register",
      "agent.reply",
      "agent.request",
      "agent.send",
      "agent.subscribe",
    ]);
  });
});

describe("agent.send tool (Tenet #10 cross-daemon messaging)", () => {
  it("daemon present: delivers and returns the message id", async () => {
    const svc = fullService({ send: vi.fn(async () => ({ delivered: true, messageId: "m-42" })) });
    const send = await getTool(makeCtx(svc), "agent.send");
    const out = await send.execute({ target: "agent-b", payload: { hi: 1 }, performative: "request" }, TOOLCTX);
    expect(out).toContain("m-42");
    expect(out).toContain("agent-b");
    expect(svc.send).toHaveBeenCalledWith({ target: "agent-b", payload: { hi: 1 }, performative: "request" });
  });

  it("omits performative when not provided (defaults applied daemon-side)", async () => {
    const svc = fullService();
    const send = await getTool(makeCtx(svc), "agent.send");
    await send.execute({ target: "agent-b", payload: "ping" }, TOOLCTX);
    expect(svc.send).toHaveBeenCalledWith({ target: "agent-b", payload: "ping" });
  });

  it("denial: surfaces the reason to the model", async () => {
    const svc = fullService({
      send: vi.fn(async () => {
        throw new Error("comm.send denied: Sender agent-a not allowed to send to agent-z");
      }),
    });
    const send = await getTool(makeCtx(svc), "agent.send");
    const out = await send.execute({ target: "agent-z", payload: "x" }, TOOLCTX);
    expect(out).toMatch(/denied/);
    expect(out).toContain("not allowed to send");
  });

  it("no daemon: clear daemon-only message, does not throw", async () => {
    const send = await getTool(makeCtx(null), "agent.send");
    const out = await send.execute({ target: "agent-b", payload: "x" }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.inbox tool", () => {
  it("daemon present: formats received messages", async () => {
    const svc = fullService({
      readInbox: vi.fn(async () => [
        makeMessage({ id: "m-1", source: "agent-a", payload: "hello", performative: "inform" }),
        makeMessage({ id: "m-2", source: "agent-c", payload: { k: 2 }, performative: "request" }),
      ]),
    });
    const inbox = await getTool(makeCtx(svc), "agent.inbox");
    const out = await inbox.execute({ limit: 10 }, TOOLCTX);
    expect(out).toContain("2 message(s)");
    expect(out).toContain("from agent-a");
    expect(out).toContain("hello");
    expect(out).toContain("[request]");
    expect(svc.readInbox).toHaveBeenCalledWith(10);
  });

  it("empty inbox: returns an empty message", async () => {
    const inbox = await getTool(makeCtx(fullService()), "agent.inbox");
    const out = await inbox.execute({}, TOOLCTX);
    expect(out).toMatch(/empty/i);
  });

  it("no daemon: clear daemon-only message", async () => {
    const inbox = await getTool(makeCtx(null), "agent.inbox");
    const out = await inbox.execute({}, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.subscribe tool (Tenet #10 C/T2 pub/sub)", () => {
  it("daemon present: subscribes to a peer's events", async () => {
    const svc = fullService();
    const subscribe = await getTool(makeCtx(svc), "agent.subscribe");
    const out = await subscribe.execute({ peerId: "agent-b", eventTypes: ["agent:leaving"] }, TOOLCTX);
    expect(out).toMatch(/Subscribed/);
    expect(out).toContain("agent-b");
    expect(svc.subscribe).toHaveBeenCalledWith("agent-b", ["agent:leaving"]);
  });

  it("denial: surfaces the reason to the model", async () => {
    const svc = fullService({
      subscribe: vi.fn(async () => {
        throw new Error("comm.subscribe: HMAC verification failed (fail-closed)");
      }),
    });
    const subscribe = await getTool(makeCtx(svc), "agent.subscribe");
    const out = await subscribe.execute({ peerId: "agent-b", eventTypes: ["agent:leaving"] }, TOOLCTX);
    expect(out).toMatch(/failed/);
  });

  it("no daemon: clear daemon-only message", async () => {
    const subscribe = await getTool(makeCtx(null), "agent.subscribe");
    const out = await subscribe.execute({ peerId: "agent-b", eventTypes: ["agent:leaving"] }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.events tool (Tenet #10 C/T2 pub/sub)", () => {
  it("daemon present: formats received coordination events", async () => {
    const svc = fullService({
      readEvents: vi.fn(async () => [
        { type: "agent:leaving", agentId: "agent-b", timestamp: 1_700_000_000_000 },
        { type: "agent:status_changed", agentId: "agent-c", timestamp: 1_700_000_000_001, payload: { status: "busy" } },
      ]),
    });
    const events = await getTool(makeCtx(svc), "agent.events");
    const out = await events.execute({ limit: 5 }, TOOLCTX);
    expect(out).toContain("2 event(s)");
    expect(out).toContain("agent:leaving from agent-b");
    expect(out).toContain("agent:status_changed from agent-c");
    expect(out).toContain("busy");
    expect(svc.readEvents).toHaveBeenCalledWith(5);
  });

  it("no events: returns an empty message", async () => {
    const events = await getTool(makeCtx(fullService()), "agent.events");
    const out = await events.execute({}, TOOLCTX);
    expect(out).toMatch(/no coordination events/i);
  });

  it("no daemon: clear daemon-only message", async () => {
    const events = await getTool(makeCtx(null), "agent.events");
    const out = await events.execute({}, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.register tool (Tenet #10 C/T3 discovery)", () => {
  it("daemon present: registers the service on the hub", async () => {
    const svc = fullService();
    const register = await getTool(makeCtx(svc), "agent.register");
    const out = await register.execute({ registry: "agent-r", serviceName: "echo" }, TOOLCTX);
    expect(out).toMatch(/Registered/);
    expect(out).toContain("echo");
    expect(svc.registerService).toHaveBeenCalledWith("agent-r", "echo");
  });

  it("no daemon: clear daemon-only message", async () => {
    const register = await getTool(makeCtx(null), "agent.register");
    const out = await register.execute({ registry: "agent-r", serviceName: "echo" }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.findPeer tool (Tenet #10 C/T3 discovery)", () => {
  it("daemon present: lists discovered providers", async () => {
    const svc = fullService({
      findPeer: vi.fn(async () => [
        { serviceName: "echo", agentId: "agent-a", socketPath: "/sock/a" },
      ]),
    });
    const findPeer = await getTool(makeCtx(svc), "agent.findPeer");
    const out = await findPeer.execute({ registry: "agent-r", serviceName: "echo" }, TOOLCTX);
    expect(out).toContain("1 provider(s)");
    expect(out).toContain("agent-a");
    expect(svc.findPeer).toHaveBeenCalledWith("agent-r", "echo");
  });

  it("no providers: returns a clear not-found message", async () => {
    const findPeer = await getTool(makeCtx(fullService()), "agent.findPeer");
    const out = await findPeer.execute({ registry: "agent-r", serviceName: "missing" }, TOOLCTX);
    expect(out).toMatch(/no provider found/i);
  });

  it("no daemon: clear daemon-only message", async () => {
    const findPeer = await getTool(makeCtx(null), "agent.findPeer");
    const out = await findPeer.execute({ registry: "agent-r", serviceName: "echo" }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.request / agent.reply tools (Tenet #10 C/T4 request-response)", () => {
  it("request: returns the correlated reply payload", async () => {
    const svc = fullService({
      request: vi.fn(async () => ({
        id: "rep-9", timestamp: 1, source: "agent-b", target: "agent-a",
        payload: { answer: 42 }, performative: "inform", correlationId: "req-9",
      } as CommMessage)),
    });
    const request = await getTool(makeCtx(svc), "agent.request");
    const out = await request.execute({ target: "agent-b", payload: { q: 1 }, timeoutMs: 1000 }, TOOLCTX);
    expect(out).toContain("Reply from");
    expect(out).toContain("42");
    expect(svc.request).toHaveBeenCalledWith("agent-b", { q: 1 }, 1000);
  });

  it("request: surfaces timeout/denial reason", async () => {
    const svc = fullService({
      request: vi.fn(async () => {
        throw new Error('comm.request to "agent-b" timed out after 1000ms (no correlated reply)');
      }),
    });
    const request = await getTool(makeCtx(svc), "agent.request");
    const out = await request.execute({ target: "agent-b", payload: {} }, TOOLCTX);
    expect(out).toMatch(/failed/);
    expect(out).toMatch(/timed out/);
  });

  it("reply: sends a correlated reply", async () => {
    const svc = fullService();
    const reply = await getTool(makeCtx(svc), "agent.reply");
    const out = await reply.execute({ target: "agent-a", correlationId: "req-9", payload: { answer: 42 } }, TOOLCTX);
    expect(out).toMatch(/Replied/);
    expect(svc.reply).toHaveBeenCalledWith("agent-a", "req-9", { answer: 42 });
  });

  it("request/reply no daemon: clear daemon-only message", async () => {
    const request = await getTool(makeCtx(null), "agent.request");
    expect(await request.execute({ target: "agent-b", payload: {} }, TOOLCTX)).toMatch(/daemon mode|unavailable/i);
    const reply = await getTool(makeCtx(null), "agent.reply");
    expect(await reply.execute({ target: "agent-a", correlationId: "x", payload: {} }, TOOLCTX)).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.broadcast tool (Tenet #10 C/T4 broadcast topology)", () => {
  it("daemon present: summarizes per-target delivery", async () => {
    const svc = fullService({
      broadcast: vi.fn(async () => [
        { target: "agent-b", delivered: true },
        { target: "agent-c", delivered: false, error: "Sender me not allowed to send to agent-c" },
      ]),
    });
    const broadcast = await getTool(makeCtx(svc), "agent.broadcast");
    const out = await broadcast.execute({ targets: ["agent-b", "agent-c"], payload: { hi: 1 } }, TOOLCTX);
    expect(out).toContain("2 target(s)");
    expect(out).toContain("1 delivered");
    expect(out).toContain("agent-b: delivered");
    expect(out).toContain("agent-c: FAILED");
    expect(svc.broadcast).toHaveBeenCalledWith(["agent-b", "agent-c"], { hi: 1 }, undefined);
  });

  it("no daemon: clear daemon-only message", async () => {
    const broadcast = await getTool(makeCtx(null), "agent.broadcast");
    const out = await broadcast.execute({ targets: ["agent-b"], payload: {} }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.pipeline tool (Tenet #10 pipeline topology)", () => {
  it("daemon present: starts the pipeline along the route", async () => {
    const svc = fullService({
      pipeline: vi.fn(async () => ({ delivered: true, pipelineId: "p-9", firstHop: "agent-b" })),
    });
    const pipeline = await getTool(makeCtx(svc), "agent.pipeline");
    const out = await pipeline.execute({ route: ["agent-b", "agent-c"], payload: { x: 1 } }, TOOLCTX);
    expect(out).toMatch(/Pipeline p-9 started/);
    expect(out).toContain("agent-b → agent-c");
    expect(svc.pipeline).toHaveBeenCalledWith(["agent-b", "agent-c"], { x: 1 }, undefined);
  });

  it("no daemon: clear daemon-only message", async () => {
    const pipeline = await getTool(makeCtx(null), "agent.pipeline");
    const out = await pipeline.execute({ route: ["agent-b"], payload: {} }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});
