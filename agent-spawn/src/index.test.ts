/**
 * agent-spawn (ledger #10): the `agent.spawnChild` ITool behavior.
 *
 * Verifies the tool consumes SERVICE_KEYS.DAEMON_SPAWN and behaves correctly in
 * three cases: daemon present (spawn succeeds), permission-lattice denial
 * (error surfaced to the model), and no daemon (clear daemon-only message).
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, IPluginService, IDaemonSpawnService, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";
import { createAgentSpawnPlugin } from "./index.js";

type SpawnInput = { agentId: string; configPath: string; statePath?: string };

/** Build a plugin context whose service registry returns `spawnService` for the
 *  DAEMON_SPAWN key (or nothing when null = non-daemon mode). */
function makeCtx(spawnService: IDaemonSpawnService | null): IPluginContext {
  const services = {
    get<T extends IPluginService>(key: { name: string }): T | undefined {
      if (spawnService && key.name === SERVICE_KEYS.DAEMON_SPAWN.name) {
        return spawnService as unknown as T;
      }
      return undefined;
    },
    has: (key: { name: string }) => spawnService !== null && key.name === SERVICE_KEYS.DAEMON_SPAWN.name,
    register: () => {},
    list: () => (spawnService ? [spawnService] : []),
    unregister: () => false,
  };
  return { services } as unknown as IPluginContext;
}

async function getTool(ctx: IPluginContext): Promise<ITool<SpawnInput>> {
  const hooks = await createAgentSpawnPlugin().factory(ctx);
  const tool = hooks.tools?.[0] as ITool<SpawnInput>;
  expect(tool.id).toBe("agent.spawnChild");
  expect(tool.skandha).toBe("samskara");
  return tool;
}

const TOOLCTX = {} as never;

describe("agent.spawnChild tool (Tenet #10 runtime spawn)", () => {
  it("daemon present: spawns and returns the child pid", async () => {
    const spawnService: IDaemonSpawnService = {
      name: "daemon-spawn",
      version: "1.0.0",
      spawnChild: vi.fn(async (input) => ({ pid: 4242, agentId: input.agentId })),
    };
    const tool = await getTool(makeCtx(spawnService));
    const out = await tool.execute({ agentId: "child-1", configPath: "./child.json" }, TOOLCTX);
    expect(out).toContain("child-1");
    expect(out).toContain("4242");
    expect(spawnService.spawnChild).toHaveBeenCalledWith({ agentId: "child-1", configPath: "./child.json" });
  });

  it("permission-lattice denial: surfaces the denial reason to the model", async () => {
    const spawnService: IDaemonSpawnService = {
      name: "daemon-spawn",
      version: "1.0.0",
      spawnChild: vi.fn(async () => {
        throw new Error("SEC-003: configPath resolves outside parent scope");
      }),
    };
    const tool = await getTool(makeCtx(spawnService));
    const out = await tool.execute({ agentId: "evil", configPath: "/etc/passwd" }, TOOLCTX);
    expect(out).toMatch(/Spawn denied/);
    expect(out).toContain("SEC-003");
  });

  it("no daemon (service absent): returns a clear daemon-only message, does not throw", async () => {
    const tool = await getTool(makeCtx(null));
    const out = await tool.execute({ agentId: "child-1", configPath: "./child.json" }, TOOLCTX);
    expect(out).toMatch(/requires the agent to run under daemon mode|unavailable/i);
  });
});
