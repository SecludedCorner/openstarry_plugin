/**
 * Tests for standard-core-commands — the 4 built-in slash commands
 * (/help /reset /quit /metrics). Shipped with zero test coverage (v0.59.7 audit).
 */

import { describe, it, expect, vi } from "vitest";
import { AgentEventType } from "@openstarry/sdk";
import type { SlashCommand } from "@openstarry/sdk";
import createCoreCommandsPlugin from "./index.js";

function makeCtx(opts?: {
  commands?: { name: string; description: string }[];
  snapshot?: { counters: Record<string, number>; gauges: Record<string, number> };
}) {
  const emitted: Array<{ type: string; payload?: unknown }> = [];
  const clear = vi.fn();
  const ctx = {
    commands: { list: () => opts?.commands ?? [] },
    sessions: { getStateManager: (_id?: string) => ({ clear }) },
    bus: { emit: (e: { type: string; payload?: unknown }) => emitted.push(e) },
    metrics: opts?.snapshot ? { getSnapshot: () => opts.snapshot } : undefined,
  };
  return { ctx: ctx as never, emitted, clear };
}

async function buildCommands(ctxObj: never): Promise<Record<string, SlashCommand>> {
  const plugin = createCoreCommandsPlugin();
  const hooks = await plugin.factory(ctxObj);
  return Object.fromEntries((hooks.commands as SlashCommand[]).map((c) => [c.name, c]));
}

describe("standard-core-commands", () => {
  it("registers exactly help/reset/quit/metrics", async () => {
    const { ctx } = makeCtx();
    const cmds = await buildCommands(ctx);
    expect(Object.keys(cmds).sort()).toEqual(["help", "metrics", "quit", "reset"]);
  });

  it("/help lists the registered commands from ctx.commands", async () => {
    const { ctx } = makeCtx({
      commands: [
        { name: "help", description: "Show available commands" },
        { name: "quit", description: "Exit the agent" },
      ],
    });
    const cmds = await buildCommands(ctx);
    const out = await cmds.help.execute("", ctx);
    expect(out).toContain("/help — Show available commands");
    expect(out).toContain("/quit — Exit the agent");
  });

  it("/reset clears session state and emits STATE_RESET", async () => {
    const { ctx, emitted, clear } = makeCtx();
    const cmds = await buildCommands(ctx);
    const out = await cmds.reset.execute("", ctx, "sess-1");
    expect(clear).toHaveBeenCalledOnce();
    expect(emitted.some((e) => e.type === AgentEventType.STATE_RESET)).toBe(true);
    expect(out).toBe("Conversation reset.");
  });

  it("/quit emits AGENT_STOPPED and returns the __QUIT__ sentinel", async () => {
    const { ctx, emitted } = makeCtx();
    const cmds = await buildCommands(ctx);
    const out = await cmds.quit.execute("", ctx);
    expect(emitted.some((e) => e.type === AgentEventType.AGENT_STOPPED)).toBe(true);
    expect(out).toBe("__QUIT__");
  });

  it("/metrics reports 'not available' when no metrics service", async () => {
    const { ctx } = makeCtx();
    const cmds = await buildCommands(ctx);
    expect(await cmds.metrics.execute("", ctx)).toBe("Metrics not available.");
  });

  it("/metrics formats counters + gauges and emits METRICS_SNAPSHOT", async () => {
    const { ctx, emitted } = makeCtx({
      snapshot: { counters: { tool_calls: 3 }, gauges: { tokens: 42 } },
    });
    const cmds = await buildCommands(ctx);
    const out = await cmds.metrics.execute("", ctx);
    expect(out).toContain("tool_calls: 3");
    expect(out).toContain("tokens: 42");
    expect(emitted.some((e) => e.type === AgentEventType.METRICS_SNAPSHOT)).toBe(true);
  });
});
