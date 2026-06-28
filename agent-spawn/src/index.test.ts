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

/** A complete IDaemonSpawnService with vi.fn defaults, overridable per test. */
function fullSpawnService(overrides: Partial<IDaemonSpawnService> = {}): IDaemonSpawnService {
  return {
    name: "daemon-spawn",
    version: "1.0.0",
    spawnChild: vi.fn(async (input) => ({ pid: 4242, agentId: input.agentId ?? "auto" })),
    supervise: vi.fn(async (agentId, strategy) => ({
      supervised: true,
      agentId,
      strategy: strategy ?? "one-for-one",
    })),
    fork: vi.fn(async (input) => ({
      childAgentId: input.agentId ?? "fork-auto",
      pid: 5151,
      forkOrigin: `parent:${input.parentSessionId}`,
      sessionId: input.parentSessionId,
      messageCount: 3,
    })),
    branch: vi.fn(async (input) =>
      input.children.map((c, i) => ({
        childAgentId: c.agentId ?? `branch-${i}`,
        pid: 6000 + i,
        forkOrigin: `parent:${input.parentSessionId}`,
        sessionId: input.parentSessionId,
        messageCount: 3,
      })),
    ),
    ...overrides,
  };
}

async function getTool<T>(ctx: IPluginContext, id: string): Promise<ITool<T>> {
  const hooks = await createAgentSpawnPlugin().factory(ctx);
  const tool = (hooks.tools ?? []).find((t) => t.id === id) as unknown as ITool<T>;
  expect(tool).toBeDefined();
  expect(tool.skandha).toBe("samskara");
  return tool;
}

const TOOLCTX = {} as never;

describe("agent-spawn plugin surface", () => {
  it("exposes spawnChild + supervise + fork + branch", async () => {
    const hooks = await createAgentSpawnPlugin().factory(makeCtx(fullSpawnService()));
    const ids = (hooks.tools ?? []).map((t) => t.id).sort();
    expect(ids).toEqual(["agent.branch", "agent.fork", "agent.spawnChild", "agent.supervise"]);
  });
});

describe("agent.spawnChild tool (Tenet #10 runtime spawn)", () => {
  it("daemon present: spawns and returns the child pid", async () => {
    const spawnService = fullSpawnService({
      spawnChild: vi.fn(async (input) => ({ pid: 4242, agentId: input.agentId ?? "auto" })),
    });
    const tool = await getTool<SpawnInput>(makeCtx(spawnService), "agent.spawnChild");
    const out = await tool.execute({ agentId: "child-1", configPath: "./child.json" }, TOOLCTX);
    expect(out).toContain("child-1");
    expect(out).toContain("4242");
    expect(spawnService.spawnChild).toHaveBeenCalledWith({ agentId: "child-1", configPath: "./child.json" });
  });

  it("permission-lattice denial: surfaces the denial reason to the model", async () => {
    const spawnService = fullSpawnService({
      spawnChild: vi.fn(async () => {
        throw new Error("SEC-003: configPath resolves outside parent scope");
      }),
    });
    const tool = await getTool<SpawnInput>(makeCtx(spawnService), "agent.spawnChild");
    const out = await tool.execute({ agentId: "evil", configPath: "/etc/passwd" }, TOOLCTX);
    expect(out).toMatch(/Spawn denied/);
    expect(out).toContain("SEC-003");
  });

  it("no daemon (service absent): returns a clear daemon-only message, does not throw", async () => {
    const tool = await getTool<SpawnInput>(makeCtx(null), "agent.spawnChild");
    const out = await tool.execute({ agentId: "child-1", configPath: "./child.json" }, TOOLCTX);
    expect(out).toMatch(/requires the agent to run under daemon mode|unavailable/i);
  });
});

type SuperviseInput = { agentId: string; strategy?: string; maxRestarts?: number };

describe("agent.supervise tool (Fractal Society restart-on-crash)", () => {
  it("daemon present: enables supervision with the given strategy", async () => {
    const spawnService = fullSpawnService();
    const tool = await getTool<SuperviseInput>(makeCtx(spawnService), "agent.supervise");
    const out = await tool.execute({ agentId: "child-1", strategy: "rest-for-one" }, TOOLCTX);
    expect(out).toMatch(/Supervising/);
    expect(out).toContain("child-1");
    expect(out).toContain("rest-for-one");
    expect(spawnService.supervise).toHaveBeenCalledWith("child-1", "rest-for-one", undefined);
  });

  it("denial (unknown child): surfaces the reason", async () => {
    const spawnService = fullSpawnService({
      supervise: vi.fn(async () => {
        throw new Error('agent.supervise: "ghost" is not a child of this agent');
      }),
    });
    const tool = await getTool<SuperviseInput>(makeCtx(spawnService), "agent.supervise");
    const out = await tool.execute({ agentId: "ghost" }, TOOLCTX);
    expect(out).toMatch(/failed/);
    expect(out).toContain("not a child");
  });

  it("no daemon (service absent): returns a clear daemon-only message", async () => {
    const tool = await getTool<SuperviseInput>(makeCtx(null), "agent.supervise");
    const out = await tool.execute({ agentId: "child-1" }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

type ForkInput = { parentSessionId: string; agentId?: string; configPath: string };
type BranchInput = { parentSessionId: string; children: Array<{ agentId?: string; configPath: string }> };

describe("agent.fork tool (Fractal Society, Spec Addendum B)", () => {
  it("daemon present: forks a child inheriting the parent session", async () => {
    const spawnService = fullSpawnService();
    const tool = await getTool<ForkInput>(makeCtx(spawnService), "agent.fork");
    const out = await tool.execute({ parentSessionId: "sess-1", agentId: "kid", configPath: "./kid.json" }, TOOLCTX);
    expect(out).toMatch(/Forked child "kid"/);
    expect(out).toContain("3 message(s)");
    expect(spawnService.fork).toHaveBeenCalledWith({
      parentSessionId: "sess-1",
      agentId: "kid",
      configPath: "./kid.json",
    });
  });

  it("denial: surfaces the reason", async () => {
    const spawnService = fullSpawnService({
      fork: vi.fn(async () => {
        throw new Error('agent.fork: parent session "ghost" not found');
      }),
    });
    const tool = await getTool<ForkInput>(makeCtx(spawnService), "agent.fork");
    const out = await tool.execute({ parentSessionId: "ghost", configPath: "./kid.json" }, TOOLCTX);
    expect(out).toMatch(/Fork failed/);
    expect(out).toContain("not found");
  });

  it("no daemon: clear daemon-only message", async () => {
    const tool = await getTool<ForkInput>(makeCtx(null), "agent.fork");
    const out = await tool.execute({ parentSessionId: "s", configPath: "./kid.json" }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});

describe("agent.branch tool (Fractal Society, Spec Addendum B)", () => {
  it("daemon present: branches N children from one snapshot", async () => {
    const spawnService = fullSpawnService();
    const tool = await getTool<BranchInput>(makeCtx(spawnService), "agent.branch");
    const out = await tool.execute(
      { parentSessionId: "sess-1", children: [{ agentId: "b1", configPath: "./b1.json" }, { agentId: "b2", configPath: "./b2.json" }] },
      TOOLCTX,
    );
    expect(out).toMatch(/Branched 2 child\(ren\)/);
    expect(out).toContain("b1");
    expect(out).toContain("b2");
  });

  it("no daemon: clear daemon-only message", async () => {
    const tool = await getTool<BranchInput>(makeCtx(null), "agent.branch");
    const out = await tool.execute({ parentSessionId: "s", children: [{ configPath: "./b.json" }] }, TOOLCTX);
    expect(out).toMatch(/daemon mode|unavailable/i);
  });
});
