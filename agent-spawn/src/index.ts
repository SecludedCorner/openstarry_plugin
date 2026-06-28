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
 * Also exposes `agent.supervise` (Fractal Society): enable restart-on-crash for a
 * child this agent spawned (one-for-one / one-for-all / rest-for-one).
 *
 * Purity: imports @openstarry/sdk (+zod) only.
 */

import { z } from "zod";
import type { IPlugin, IPluginContext, PluginHooks, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";

interface SpawnChildInput {
  agentId?: string;
  name?: string;
  configPath: string;
  statePath?: string;
}

const superviseSchema = z.object({
  agentId: z.string().min(1).describe("Id of a child THIS agent spawned"),
  strategy: z
    .enum(["one-for-one", "one-for-all", "rest-for-one"])
    .optional()
    .describe("Restart strategy on crash (default 'one-for-one')"),
  maxRestarts: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Max restarts before the daemon gives up (default 3)"),
});
type SuperviseInput = z.infer<typeof superviseSchema>;

function createSuperviseTool(ctx: IPluginContext): ITool<SuperviseInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.supervise",
    description:
      "Enable restart-on-crash supervision for a child agent THIS agent spawned " +
      "(fractal society resilience, Tenet #10). Requires daemon mode. If the child's " +
      "process dies while still running (a crash, not a graceful stop), the daemon " +
      "restarts a set chosen by `strategy`: one-for-one (just it), one-for-all (the " +
      "whole group), rest-for-one (it + those supervised after it), up to `maxRestarts`.",
    parameters: superviseSchema,
    async execute(input: SuperviseInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_SPAWN);
      if (!svc) {
        return (
          "agent.supervise is unavailable: no daemon-spawn service is registered. " +
          "Supervision requires daemon mode (`daemon start`)."
        );
      }
      try {
        const res = await svc.supervise(input.agentId, input.strategy, input.maxRestarts);
        return `Supervising "${res.agentId}" with strategy "${res.strategy}" (restart on crash).`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Supervise "${input.agentId}" failed: ${reason}`;
      }
    },
  };
}

function createSpawnChildTool(ctx: IPluginContext): ITool<SpawnChildInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.spawnChild",
    description:
      "Spawn a child agent as a new process under THIS agent (fractal society, " +
      "Tenet #10). Requires daemon mode. The child is subject to the permission " +
      "lattice: its config path must resolve within the parent's scope and the " +
      "process-tree depth limit is enforced. `agentId` is optional — if omitted, " +
      "a unique `<parent>-<generation>` id is auto-assigned; if given, a collision " +
      "is rejected. `name` is an optional human-friendly label. Returns the child's " +
      "id + pid on success.",
    parameters: z.object({
      agentId: z.string().min(1).optional().describe("Optional unique id; auto-generated when omitted"),
      name: z.string().optional().describe("Optional human-friendly label for the child agent"),
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
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          configPath: input.configPath,
          ...(input.statePath !== undefined ? { statePath: input.statePath } : {}),
        });
        return `Spawned child agent "${res.agentId}" (pid ${res.pid}) under this agent.`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Spawn denied for "${input.agentId ?? "(auto-id)"}": ${reason}`;
      }
    },
  };
}

const forkSchema = z.object({
  parentSessionId: z.string().min(1).describe("This agent's session id to snapshot into the child"),
  agentId: z.string().min(1).optional().describe("Optional unique child id; auto-generated when omitted"),
  name: z.string().optional().describe("Optional human-friendly label for the child"),
  configPath: z.string().min(1).describe("Path to the child's agent config file (within parent scope)"),
  statePath: z.string().optional().describe("Optional daemon state dir; defaults to the daemon's home"),
});
type ForkInput = z.infer<typeof forkSchema>;

const branchSchema = z.object({
  parentSessionId: z.string().min(1).describe("This agent's session id to snapshot into every branch"),
  children: z
    .array(
      z.object({
        agentId: z.string().min(1).optional(),
        name: z.string().optional(),
        configPath: z.string().min(1),
        statePath: z.string().optional(),
      }),
    )
    .min(1)
    .describe("Child configs; each is forked from the SAME parent snapshot (one branch group)"),
});
type BranchInput = z.infer<typeof branchSchema>;

function createForkTool(ctx: IPluginContext): ITool<ForkInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.fork",
    description:
      "Fork a child agent from THIS agent's CURRENT state (fractal society, Tenet " +
      "#10, Spec Addendum B). Requires daemon mode. The child inherits the parent's " +
      "session snapshot (the conversation so far); capabilities stay child ⊆ parent " +
      "(NOT bypassed); memory/alaya are NOT inherited. Returns the child id + how " +
      "many messages carried over.",
    parameters: forkSchema,
    async execute(input: ForkInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_SPAWN);
      if (!svc) {
        return "agent.fork is unavailable: no daemon-spawn service is registered. Fork requires daemon mode (`daemon start`).";
      }
      try {
        const res = await svc.fork({
          parentSessionId: input.parentSessionId,
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          configPath: input.configPath,
          ...(input.statePath !== undefined ? { statePath: input.statePath } : {}),
        });
        return `Forked child "${res.childAgentId}" (pid ${res.pid}) inheriting ${res.messageCount} message(s) from session ${res.sessionId}.`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Fork failed: ${reason}`;
      }
    },
  };
}

function createBranchTool(ctx: IPluginContext): ITool<BranchInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.branch",
    description:
      "Branch THIS agent into N parallel children from the SAME session snapshot " +
      "(fractal society, Tenet #10, Spec Addendum B). Requires daemon mode. Each " +
      "child inherits the same parent context and shares a forkOrigin (one branch " +
      "group). Capabilities stay child ⊆ parent; memory/alaya are NOT inherited.",
    parameters: branchSchema,
    async execute(input: BranchInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_SPAWN);
      if (!svc) {
        return "agent.branch is unavailable: no daemon-spawn service is registered. Branch requires daemon mode (`daemon start`).";
      }
      try {
        const res = await svc.branch({ parentSessionId: input.parentSessionId, children: input.children });
        const ids = res.map((r) => r.childAgentId).join(", ");
        return `Branched ${res.length} child(ren) from session ${input.parentSessionId}: ${ids}.`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Branch failed: ${reason}`;
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
        "Exposes runtime child-spawning (`agent.spawnChild`), restart-on-crash supervision (`agent.supervise`), and fork/branch (`agent.fork` / `agent.branch`) so the agent's own loop can spawn, supervise, and fork sub-agents (Tenet #10 / Fractal Society; daemon mode only)",
      skandha: "samskara" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [
          createSpawnChildTool(ctx),
          createSuperviseTool(ctx),
          createForkTool(ctx),
          createBranchTool(ctx),
        ],
      };
    },
  };
}

export default createAgentSpawnPlugin;
