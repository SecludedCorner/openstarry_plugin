/**
 * Tests for context-summary plugin.
 *
 * Success criteria:
 *   S1-1: Plugin loads without error (createContextSummaryPlugin returns valid IPlugin)
 *   S1-2: assembleContext() returns valid Message[] for empty, single, many messages
 *   S1-3: Fallback to sliding-window when no provider available
 *   S1-4: factory() returns { contextManager } (PluginHooks.contextManager registered)
 *   S1-5: ContextSummaryManager is a distinct class (not re-exported from sliding-window)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, IPluginContext, IPlugin } from "@openstarry/sdk";
import { createContextSummaryPlugin, ContextSummaryManager } from "../index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(
  role: "user" | "assistant" | "system",
  text: string,
  id?: string,
): Message {
  return {
    id: id ?? `msg-${Math.random().toString(36).slice(2)}`,
    role,
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

function makeCtx(overrides: Partial<IPluginContext> = {}): IPluginContext {
  return {
    bus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as IPluginContext["bus"],
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    } as unknown as IPluginContext["sessions"],
    providers: undefined,
    ...overrides,
  };
}

// ── S1-1: Plugin loads without error ─────────────────────────────────────────

describe("S1-1: createContextSummaryPlugin", () => {
  it("returns an object with manifest and factory", () => {
    const plugin = createContextSummaryPlugin();
    expect(plugin).toBeDefined();
    expect(plugin.manifest).toBeDefined();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/context-summary");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
    expect(typeof plugin.factory).toBe("function");
  });

  it("sets skandha to samjna", () => {
    const plugin = createContextSummaryPlugin();
    expect(plugin.manifest.skandha).toBe("samjna");
  });

  it("sets criticality to optional-degraded", () => {
    const plugin = createContextSummaryPlugin();
    expect(plugin.manifest.criticality).toBe("optional-degraded");
  });

  it("accepts empty config without throwing", () => {
    expect(() => createContextSummaryPlugin()).not.toThrow();
    expect(() => createContextSummaryPlugin({})).not.toThrow();
    expect(() =>
      createContextSummaryPlugin({ preserveCount: 3, minCompressTokens: 100 }),
    ).not.toThrow();
  });
});

// ── S1-4: factory() returns { contextManager } ───────────────────────────────

describe("S1-4: factory()", () => {
  it("returns PluginHooks with contextManager property", async () => {
    const plugin: IPlugin = createContextSummaryPlugin();
    const ctx = makeCtx();
    const hooks = await plugin.factory(ctx);
    expect(hooks).toBeDefined();
    expect(hooks.contextManager).toBeDefined();
    expect(typeof hooks.contextManager.assembleContext).toBe("function");
  });
});

// ── S1-2: assembleContext() returns valid Message[] ───────────────────────────

describe("S1-2: assembleContext()", () => {
  let manager: ContextSummaryManager;

  beforeEach(() => {
    manager = new ContextSummaryManager({}, makeCtx());
  });

  it("returns [] for empty messages", () => {
    expect(manager.assembleContext([], 5)).toEqual([]);
  });

  it("returns system messages only when no conversation", () => {
    const sys = makeMsg("system", "You are helpful.");
    const result = manager.assembleContext([sys], 5);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
  });

  it("returns single user message unchanged when below minCompressTokens", () => {
    const user = makeMsg("user", "hello");
    const result = manager.assembleContext([user], 5);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("preserves system messages in all output", () => {
    const sys = makeMsg("system", "You are an AI.");
    const user1 = makeMsg("user", "Message 1");
    const ass1 = makeMsg("assistant", "Response 1");
    const user2 = makeMsg("user", "Message 2");
    const result = manager.assembleContext([sys, user1, ass1, user2], 2);
    expect(result.some((m) => m.role === "system")).toBe(true);
  });

  it("returns valid Message[] for many messages", () => {
    const messages: Message[] = [
      makeMsg("system", "System prompt"),
      ...Array.from({ length: 10 }, (_, i) => [
        makeMsg("user", `User message ${i}`),
        makeMsg("assistant", `Assistant response ${i}`),
      ]).flat(),
    ];
    const result = manager.assembleContext(messages, 3);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    result.forEach((m) => {
      expect(m).toHaveProperty("id");
      expect(m).toHaveProperty("role");
      expect(m).toHaveProperty("content");
      expect(m).toHaveProperty("createdAt");
    });
  });
});

// ── S1-3: Fallback to sliding-window when no provider ────────────────────────

describe("S1-3: sliding-window fallback", () => {
  it("falls back gracefully when ctx.providers is undefined", () => {
    const ctxNoProvider = makeCtx({ providers: undefined });
    const manager = new ContextSummaryManager(
      { minCompressTokens: 1 },  // low threshold to force compress path
      ctxNoProvider,
    );

    // Build enough messages to create a compressible region.
    const messages: Message[] = [
      makeMsg("system", "You are helpful."),
      ...Array.from({ length: 8 }, (_, i) => [
        makeMsg("user", `User message number ${i} with some content`),
        makeMsg("assistant", `Assistant reply number ${i} with response text`),
      ]).flat(),
    ];

    const result = manager.assembleContext(messages, 4);

    // Should still return a valid Message[] (sliding-window result)
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // System message must be present
    expect(result.some((m) => m.role === "system")).toBe(true);
  });

  it("limits output turns via sliding-window fallback", () => {
    const ctxNoProvider = makeCtx({ providers: undefined });
    const manager = new ContextSummaryManager(
      { minCompressTokens: 1 },
      ctxNoProvider,
    );

    const messages: Message[] = Array.from({ length: 10 }, (_, i) => [
      makeMsg("user", `Question ${i}`),
      makeMsg("assistant", `Answer ${i}`),
    ]).flat();

    const result = manager.assembleContext(messages, 2);
    const userMsgs = result.filter((m) => m.role === "user");
    // Should keep at most 2 user turns
    expect(userMsgs.length).toBeLessThanOrEqual(2);
  });
});

// ── S1-5: Distinct class ─────────────────────────────────────────────────────

describe("S1-5: ContextSummaryManager is a distinct class", () => {
  it("exports ContextSummaryManager class (not a plain object factory)", () => {
    expect(typeof ContextSummaryManager).toBe("function");
    // It must be a class constructor, so calling new should work
    const ctx = makeCtx();
    const instance = new ContextSummaryManager({}, ctx);
    expect(instance).toBeInstanceOf(ContextSummaryManager);
  });

  it("implements IContextManager interface with assembleContext method", () => {
    const ctx = makeCtx();
    const instance = new ContextSummaryManager({}, ctx);
    expect(typeof instance.assembleContext).toBe("function");
  });

  it("is named ContextSummaryManager (not SlidingWindowContextManager)", () => {
    expect(ContextSummaryManager.name).toBe("ContextSummaryManager");
  });
});
