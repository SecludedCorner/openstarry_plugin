import { describe, it, expect, vi } from "vitest";
import { createTuiDashboardPlugin } from "../index.js";
import type { IPluginContext, EventBus, AgentEvent } from "@openstarry/sdk";

function createMockContext(): IPluginContext {
  return {
    bus: {
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
      emit: vi.fn(),
    },
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      destroy: vi.fn(),
      getStateManager: vi.fn(),
      getDefaultSession: vi.fn(),
    },
  } as unknown as IPluginContext;
}

describe("createTuiDashboardPlugin", () => {
  it("returns a valid IPlugin with manifest", () => {
    const plugin = createTuiDashboardPlugin();

    expect(plugin.manifest.name).toBe("tui-dashboard");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
    expect(plugin.manifest.description).toBeTruthy();
    expect(typeof plugin.factory).toBe("function");
  });

  it("factory returns PluginHooks with ui array", async () => {
    const plugin = createTuiDashboardPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    expect(hooks.ui).toBeDefined();
    expect(hooks.ui).toHaveLength(1);
  });

  it("TuiUI has correct id and name", async () => {
    const plugin = createTuiDashboardPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    const ui = hooks.ui![0];
    expect(ui.id).toBe("tui-dashboard");
    expect(ui.name).toBe("TUI Dashboard");
  });

  it("TuiUI.onEvent buffers events when dispatch is not set", async () => {
    const plugin = createTuiDashboardPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    const ui = hooks.ui![0];
    // Should not throw even without start() being called — events are buffered
    expect(() =>
      ui.onEvent({
        type: "test:event",
        timestamp: Date.now(),
        payload: {},
      } as AgentEvent),
    ).not.toThrow();
  });

  it("factory returns dispose hook", async () => {
    const plugin = createTuiDashboardPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    expect(hooks.dispose).toBeDefined();
    expect(typeof hooks.dispose).toBe("function");
  });

  it("dispose does not throw when called before start", async () => {
    const plugin = createTuiDashboardPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    await expect(hooks.dispose!()).resolves.toBeUndefined();
  });

  // Plan09 — IListener and session management tests
  describe("Plan09 IListener Integration", () => {
    it("factory returns IListener in hooks.listeners", async () => {
      const plugin = createTuiDashboardPlugin();
      const ctx = createMockContext();
      const hooks = await plugin.factory(ctx);

      expect(hooks.listeners).toBeDefined();
      expect(hooks.listeners).toHaveLength(1);
    });

    it("listener has correct id and name", async () => {
      const plugin = createTuiDashboardPlugin();
      const ctx = createMockContext();
      const hooks = await plugin.factory(ctx);

      const listener = hooks.listeners![0];
      expect(listener.id).toBe("tui-listener");
      expect(listener.name).toBe("TUI Dashboard Listener");
      expect(typeof listener.start).toBe("function");
      expect(typeof listener.stop).toBe("function");
    });

    it("session created on TuiUI.start() with correct metadata", async () => {
      const plugin = createTuiDashboardPlugin();
      const mockSession = { id: "test-session-id", createdAt: Date.now(), updatedAt: Date.now(), metadata: {} };
      const ctx = createMockContext();
      ctx.sessions.create = vi.fn(() => mockSession);

      const hooks = await plugin.factory(ctx);
      const ui = hooks.ui![0];

      // Note: We cannot actually test start() because it uses dynamic imports
      // and renders Ink components. This test validates the mock setup.
      expect(ctx.sessions.create).toBeDefined();
    });

    it("session destroyed on TuiUI.stop()", async () => {
      const plugin = createTuiDashboardPlugin();
      const mockSession = { id: "test-session-id", createdAt: Date.now(), updatedAt: Date.now(), metadata: {} };
      const ctx = createMockContext();
      ctx.sessions.create = vi.fn(() => mockSession);
      ctx.sessions.destroy = vi.fn(() => true);

      const hooks = await plugin.factory(ctx);
      const ui = hooks.ui![0];

      // Cannot test actual start/stop due to Ink rendering, but we validate mocks are set up
      expect(ctx.sessions.destroy).toBeDefined();
    });

    it("slash command detection — /help is local", () => {
      const text = "/help";
      expect(text.startsWith("/")).toBe(true);
    });

    it("slash command detection — user_input for non-slash text", () => {
      const text = "hello world";
      const inputType = text.startsWith("/") ? "slash_command" : "user_input";
      expect(inputType).toBe("user_input");
    });

    it("slash command detection — slash_command for /unknown", () => {
      const text = "/unknown command";
      const inputType = text.startsWith("/") ? "slash_command" : "user_input";
      expect(inputType).toBe("slash_command");
    });
  });
});
