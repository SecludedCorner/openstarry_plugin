/**
 * agent-spawn — expose runtime child-spawning as the `agent.spawnChild` tool
 * (ledger #10, 2026-06-15).
 *
 * Five Aggregates Mapping: ITool (行蘊) whose action is "spawn a sub-agent".
 *
 * Closes the Tenet #10 gap that child-process spawning was config-time or driven
 * by an EXTERNAL daemon RPC client only — there was no surface for the running
 * agent's own cognition loop to decide to spawn. This tool consumes the daemon's
 * SERVICE_KEYS.DAEMON_SPAWN service (registered by the daemon, backed by its
 * spawnChild handler which enforces the F-5 permission lattice + SEC-003 path
 * traversal). Outside daemon mode the service is absent and the tool returns a
 * clear daemon-only message rather than throwing.
 *
 * Purity: imports @openstarry/sdk (+zod) only.
 */

import { z } from "zod";
import type { IPlugin, IPluginContext, PluginHooks, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";

interface SpawnChildInput {
  agentId: string;
  configPath: string;
  statePath?: string;
}

function createSpawnChildTool(ctx: IPluginContext): ITool<SpawnChildInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.spawnChild",
    description:
      "Spawn a child agent as a new process under THIS agent (fractal society, " +
      "Tenet #10). Requires daemon mode. The child is subject to the permission " +
      "lattice: its config path must resolve within the parent's scope and the " +
      "process-tree depth limit is enforced. Returns the child's pid on success.",
    parameters: z.object({
      agentId: z.string().min(1).describe("Unique id for the child agent"),
      configPath: z.string().min(1).describe("Path to the child's agent config file (within parent scope)"),
      statePath: z.string().optional().describe("Optional daemon state dir; defaults to the daemon's home"),
    }),
    async execute(input: SpawnChildInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_SPAWN);
      if (!svc) {
        return (
          "agent.spawnChild is unavailable: no daemon-spawn service is registered. " +
          "Runtime child spawning requires the agent to run under daemon mode " +
          "(`daemon start`); in foreground/CLI mode there is no process tree to spawn into."
        );
      }
      try {
        const res = await svc.spawnChild({
          agentId: input.agentId,
          configPath: input.configPath,
          ...(input.statePath !== undefined ? { statePath: input.statePath } : {}),
        });
        return `Spawned child agent "${res.agentId}" (pid ${res.pid}) under this agent.`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Spawn denied for "${input.agentId}": ${reason}`;
      }
    },
  };
}

export function createAgentSpawnPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/agent-spawn",
      version: "0.1.0-alpha",
      description:
        "Exposes runtime child-spawning as the `agent.spawnChild` tool so the agent's own loop can spawn sub-agents (Tenet #10; daemon mode only)",
      skandha: "samskara" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [createSpawnChildTool(ctx)],
      };
    },
  };
}

export default createAgentSpawnPlugin;
