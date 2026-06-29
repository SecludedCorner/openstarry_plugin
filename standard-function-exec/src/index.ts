/**
 * standard-function-exec — guarded command-execution ITool (samskara/行蘊).
 *
 * Exposes ONE tool `exec.run` that runs a single OS command via child_process.execFile
 * with shell:false — argv is passed as a string[] and NEVER concatenated into a shell,
 * which is the real security boundary. Layered on top (defense-in-depth + observability):
 *   - allowShell master switch, DEFAULT OFF (fail-closed: denies everything by default);
 *   - exact-match executable allowlist (empty = nothing runs);
 *   - shell-control metacharacter rejection (&&, ||, |, ;, `, $( , >, <, &, newline);
 *   - substring denylist (rm -rf, mkfs, sudo, curl|sh, fork bomb, ...).
 *
 * On any block the tool emits the EXISTING AgentEventType.TOOL_BLOCKED event (no new SDK
 * surface) and throws SecurityError. Policy is plugin-local (src/policy.ts) merged under
 * the factory `opts` then `ctx.config`, so agent.json wins and the microkernel stays pure.
 *
 * HONEST SCOPE: this is NOT a sandbox. A permitted command still runs with the agent's
 * own OS privileges. The guard reduces accidental/obvious-malicious blast radius and gives
 * an audit trail; it is not a containment boundary. For true isolation, run under an OS
 * sandbox / container (out of scope — see the v0.59.9 plan honest-future notes).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ITool,
  ToolContext,
} from "@openstarry/sdk";
import { SecurityError, AgentEventType } from "@openstarry/sdk";
import { resolvePolicy, evaluate, type ExecGuardPolicy } from "./policy.js";

const pexec = promisify(execFile);

function makeExecTool(policy: ExecGuardPolicy): ITool<{ command: string; args?: string[] }> {
  return {
    skandha: "samskara" as const,
    id: "exec.run",
    description:
      "Run a single OS command via execFile (NO shell). Subject to a default-off allowShell " +
      "gate, an exact-match command allowlist, shell-metacharacter rejection and a denylist. " +
      "args are passed as a string array, never through a shell.",
    metadata: {
      hasSideEffects: true,
      riskCategory: "destructive" as const,
      requiresConfirmation: true,
    },
    parameters: z.object({
      command: z.string().describe("The executable to run (e.g. 'node'). NOT a shell line."),
      args: z.array(z.string()).optional().describe("Arguments, passed verbatim as argv (no shell)."),
    }),
    async execute(input, ctx: ToolContext) {
      const args = input.args ?? [];
      const verdict = evaluate(input.command, args, policy);
      if (!verdict.ok) {
        ctx.bus.emit({
          type: AgentEventType.TOOL_BLOCKED,
          timestamp: Date.now(),
          payload: { toolCallId: "exec.run", name: "exec.run", reason: verdict.reason },
        });
        throw new SecurityError(`exec.run blocked: ${verdict.reason}`);
      }
      const { stdout, stderr } = await pexec(input.command, args, {
        timeout: policy.timeoutMs,
        cwd: ctx.workingDirectory,
        shell: false,
        maxBuffer: 1024 * 1024,
      });
      return stdout + (stderr ? `\n[stderr] ${stderr}` : "");
    },
  };
}

export function createExecPlugin(opts?: Partial<ExecGuardPolicy>): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/standard-function-exec",
      version: "0.1.0-alpha",
      description:
        "Guarded command execution tool (execFile, allowlist + denylist, default-off shell gate)",
      skandha: "samskara" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // ctx.config (from agent.json) wins over factory opts.
      const merged = resolvePolicy({ ...opts, ...(ctx.config as Partial<ExecGuardPolicy>) });
      return { tools: [makeExecTool(merged)] };
    },
  };
}

export default createExecPlugin;
