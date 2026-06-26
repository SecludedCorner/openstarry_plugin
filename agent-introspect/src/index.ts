/**
 * agent-introspect — expose read-only process-tree introspection as in-loop
 * tools: `agent.listChildren` and `agent.processTree` (Doc 11 introspection slice).
 *
 * Five Aggregates Mapping: ITool (行蘊) whose action is "observe the agent society".
 *
 * Doc 11 (Agent Manager) specced agent:list()/agent:status() but the only
 * surfaces were the operator `ps` CLI + external IPC clients — the running
 * agent's own loop had no way to see its children. These tools consume the
 * daemon's SERVICE_KEYS.DAEMON_INTROSPECT service (read-only; no spawn/kill).
 * Outside daemon mode the service is absent and the tools return a clear
 * daemon-only message rather than throwing.
 *
 * Purity: imports @openstarry/sdk (+zod) only.
 */

import { z } from "zod";
import type { IPlugin, IPluginContext, PluginHooks, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";

const DAEMON_ONLY =
  "agent introspection is unavailable: no daemon-introspect service is registered. " +
  "It requires the agent to run under daemon mode (`daemon start`); in foreground/CLI " +
  "mode there is no process tree to inspect.";

interface ListChildrenInput {
  parentId?: string;
}

function createListChildrenTool(ctx: IPluginContext): ITool<ListChildrenInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.listChildren",
    description:
      "List the direct child agents of an agent (defaults to THIS agent), with each " +
      "child's pid, lifecycle status, uptime, and config path. Read-only. Requires daemon mode.",
    parameters: z.object({
      parentId: z.string().optional().describe("Parent agent id; defaults to this agent"),
    }),
    async execute(input: ListChildrenInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_INTROSPECT);
      if (!svc) return DAEMON_ONLY;
      const parentId = input.parentId ?? ctx.agentId;
      const children = await svc.listChildren(parentId);
      return JSON.stringify({ parentId, count: children.length, children }, null, 2);
    },
  };
}

function createProcessTreeTool(ctx: IPluginContext): ITool<Record<string, never>> {
  return {
    skandha: "samskara" as const,
    id: "agent.processTree",
    description:
      "Return the agent process tree (roots → children, depth ≤ 3): each node's " +
      "agentId, pid, status, and depth. Read-only. Requires daemon mode.",
    parameters: z.object({}),
    async execute(): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_INTROSPECT);
      if (!svc) return DAEMON_ONLY;
      const tree = await svc.processTree();
      return JSON.stringify({ roots: tree.length, tree }, null, 2);
    },
  };
}

export function createAgentIntrospectPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/agent-introspect",
      version: "0.1.0-alpha",
      description:
        "Read-only in-loop tools agent.listChildren / agent.processTree for the agent to observe its child agents (Doc 11; daemon mode only)",
      skandha: "samskara" as const,
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [createListChildrenTool(ctx), createProcessTreeTool(ctx)],
      };
    },
  };
}

export default createAgentIntrospectPlugin;
