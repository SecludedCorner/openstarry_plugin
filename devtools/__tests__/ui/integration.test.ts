import { describe, it, expect } from "vitest";
import { createDevtoolsPlugin } from "../../src/index.js";
import type { PluginHooks, AgentEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

function createMockContext(): any {
  const handlers: Array<(e: AgentEvent) => void> = [];
  return {
    bus: {
      onAny: (handler: (e: AgentEvent) => void) => {
        handlers.push(handler);
        return () => {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        };
      },
      emit: (event: AgentEvent) => {
        for (const h of handlers) h(event);
      },
      on: () => () => {},
      once: () => () => {},
    },
    sessions: {
      list: () => [{ id: "__default__", metadata: {} }],
      getDefaultSession: () => ({ id: "__default__", metadata: {} }),
      create: () => ({ id: "new", metadata: {} }),
      destroy: () => {},
    },
    pushInput: () => {},
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config: {},
  };
}

describe("DevTools Plugin Integration", () => {
  it("should create plugin with valid manifest", () => {
    const plugin = createDevtoolsPlugin();
    expect(plugin.manifest.name).toBe("devtools");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
  });

  it("should return valid hooks from factory", async () => {
    const plugin = createDevtoolsPlugin();
    const hooks = await plugin.factory(createMockContext());
    expect(hooks.listeners).toHaveLength(1);
    expect(hooks.ui).toHaveLength(1);
    expect(hooks.commands).toHaveLength(3);
    expect(hooks.dispose).toBeDefined();
  });

  it("should register slash commands with correct names", async () => {
    const plugin = createDevtoolsPlugin();
    const hooks = await plugin.factory(createMockContext());
    const names = hooks.commands!.map((c) => c.name);
    expect(names).toContain("devtools");
    expect(names).toContain("metrics");
    expect(names).toContain("debug");
  });

  it("should dispose cleanly", async () => {
    const plugin = createDevtoolsPlugin();
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);
    // Start listener
    await hooks.listeners![0].start?.();
    // Dispose should not throw
    await hooks.dispose!();
  });

  it("should collect metrics on events when listener is started", async () => {
    const plugin = createDevtoolsPlugin({ metricsInterval: 100000 }); // Long interval to avoid auto-emit
    const ctx = createMockContext();
    const hooks = await plugin.factory(ctx);

    await hooks.listeners![0].start?.();

    // Emit some events
    ctx.bus.emit({ type: AgentEventType.TOOL_EXECUTING, timestamp: Date.now(), payload: { toolName: "test-tool" } });
    ctx.bus.emit({ type: AgentEventType.TOOL_RESULT, timestamp: Date.now(), payload: { toolName: "test-tool" } });

    // Get metrics via command
    const metricsCmd = hooks.commands!.find((c) => c.name === "metrics")!;
    const output = await metricsCmd.execute("", ctx);
    expect(output).toContain("DevTools Metrics Snapshot");

    await hooks.dispose!();
  });
});
