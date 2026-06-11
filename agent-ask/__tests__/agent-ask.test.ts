/**
 * agent-ask unit tests (TENET-2026-06-11 — Tenet #10 load-bearing plugin).
 *
 * Stubbed IPluginContext with a minimal real event bus: execute() must push
 * the prompt into the loop (session-scoped), resolve with the session's last
 * assistant text on LOOP_FINISHED, reject on LOOP_ERROR or timeout, never
 * cross-talk between sessions, and always clean up (unsubscribe + destroy).
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, ITool, AgentEvent, InputEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import createAgentAskPlugin from "../src/index.js";

type Handler = (event: AgentEvent) => void;

function makeMiniBus() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(type: string, handler: Handler): () => void {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    once: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    emit(event: AgentEvent): void {
      for (const h of handlers.get(event.type) ?? []) h(event);
    },
    listenerCount(type: string): number {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

function makeCtx() {
  const bus = makeMiniBus();
  let counter = 0;
  const destroyed: string[] = [];
  const pushed: InputEvent[] = [];
  const ctx = {
    bus,
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: (event: InputEvent) => { pushed.push(event); },
    sessions: {
      create: (metadata?: Record<string, unknown>) => ({
        id: `session-${++counter}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: metadata ?? {},
      }),
      get: () => undefined,
      list: () => [],
      destroy: (id: string) => { destroyed.push(id); return true; },
      getStateManager: () => ({} as never),
      getDefaultSession: () => ({ id: "default", createdAt: 0, updatedAt: 0, metadata: {} }),
    },
  } as unknown as IPluginContext;
  return { ctx, bus, destroyed, pushed };
}

async function makeTool(ctx: IPluginContext): Promise<ITool<{ prompt: string; timeoutMs?: number }>> {
  const hooks = await createAgentAskPlugin().factory(ctx);
  return hooks.tools![0] as ITool<{ prompt: string; timeoutMs?: number }>;
}

function assistantEvent(sessionId: string, text: string): AgentEvent {
  return {
    type: AgentEventType.MESSAGE_ASSISTANT,
    timestamp: Date.now(),
    payload: { sessionId, message: { role: "assistant", content: [{ type: "text", text }] } },
  };
}

function finishedEvent(sessionId: string): AgentEvent {
  return { type: AgentEventType.LOOP_FINISHED, timestamp: Date.now(), payload: { traceId: "t", sessionId } };
}

describe("agent.ask (TENET-2026-06-11)", () => {
  it("pushes the prompt session-scoped and resolves with the assistant answer on LOOP_FINISHED", async () => {
    const { ctx, bus, pushed } = makeCtx();
    const tool = await makeTool(ctx);

    const pending = tool.execute({ prompt: "hello fractal" }, {} as never);
    expect(pushed.length).toBe(1);
    const sessionId = pushed[0].sessionId!;
    expect(pushed[0].data).toBe("hello fractal");
    expect(pushed[0].source).toBe("agent-ask");

    bus.emit(assistantEvent(sessionId, "the answer"));
    bus.emit(finishedEvent(sessionId));

    await expect(pending).resolves.toBe("the answer");
  });

  it("keeps only the LAST assistant message of the session (multi-round loops)", async () => {
    const { ctx, bus, pushed } = makeCtx();
    const tool = await makeTool(ctx);
    const pending = tool.execute({ prompt: "x" }, {} as never);
    const sessionId = pushed[0].sessionId!;

    bus.emit(assistantEvent(sessionId, "intermediate tool-round text"));
    bus.emit(assistantEvent(sessionId, "FINAL"));
    bus.emit(finishedEvent(sessionId));

    await expect(pending).resolves.toBe("FINAL");
  });

  it("ignores events from OTHER sessions (no cross-talk between concurrent asks)", async () => {
    const { ctx, bus, pushed } = makeCtx();
    const tool = await makeTool(ctx);

    const ask1 = tool.execute({ prompt: "one" }, {} as never);
    const ask2 = tool.execute({ prompt: "two" }, {} as never);
    const s1 = pushed[0].sessionId!;
    const s2 = pushed[1].sessionId!;
    expect(s1).not.toBe(s2);

    bus.emit(assistantEvent(s2, "answer-two"));
    bus.emit(finishedEvent(s2));
    bus.emit(assistantEvent(s1, "answer-one"));
    bus.emit(finishedEvent(s1));

    await expect(ask1).resolves.toBe("answer-one");
    await expect(ask2).resolves.toBe("answer-two");
  });

  it("rejects on LOOP_ERROR for the session", async () => {
    const { ctx, bus, pushed } = makeCtx();
    const tool = await makeTool(ctx);
    const pending = tool.execute({ prompt: "x" }, {} as never);
    const sessionId = pushed[0].sessionId!;

    bus.emit({
      type: AgentEventType.LOOP_ERROR,
      timestamp: Date.now(),
      payload: { sessionId, error: "provider exploded" },
    });

    await expect(pending).rejects.toThrow(/provider exploded/);
  });

  it("rejects on timeout when the loop never finishes", async () => {
    const { ctx, pushed } = makeCtx();
    const tool = await makeTool(ctx);
    const pending = tool.execute({ prompt: "x", timeoutMs: 50 }, {} as never);
    expect(pushed.length).toBe(1);
    await expect(pending).rejects.toThrow(/no answer within 50ms/);
  });

  it("always cleans up: session destroyed and bus handlers removed (resolve AND reject paths)", async () => {
    const { ctx, bus, destroyed, pushed } = makeCtx();
    const tool = await makeTool(ctx);

    const ok = tool.execute({ prompt: "x" }, {} as never);
    const s1 = pushed[0].sessionId!;
    bus.emit(assistantEvent(s1, "fine"));
    bus.emit(finishedEvent(s1));
    await ok;

    const bad = tool.execute({ prompt: "y", timeoutMs: 30 }, {} as never);
    const s2 = pushed[1].sessionId!;
    await expect(bad).rejects.toThrow();

    expect(destroyed).toContain(s1);
    expect(destroyed).toContain(s2);
    expect(bus.listenerCount(AgentEventType.MESSAGE_ASSISTANT)).toBe(0);
    expect(bus.listenerCount(AgentEventType.LOOP_FINISHED)).toBe(0);
    expect(bus.listenerCount(AgentEventType.LOOP_ERROR)).toBe(0);
  });

  it("resolves with empty string when the loop finishes without assistant text", async () => {
    const { ctx, bus, pushed } = makeCtx();
    const tool = await makeTool(ctx);
    const pending = tool.execute({ prompt: "x" }, {} as never);
    bus.emit(finishedEvent(pushed[0].sessionId!));
    await expect(pending).resolves.toBe("");
  });
});
