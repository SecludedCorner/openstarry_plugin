/**
 * agent-ask — expose the agent's COGNITION LOOP as a tool (TENET-2026-06-11).
 *
 * Five Aggregates Mapping: ITool (行蘊) whose action is "think about this".
 *
 * Load-bearing piece of the Tenet #10 fractal-composition proof: until this
 * plugin, composing agents over MCP composed their *tool registries* only —
 * mcp-server's tools/call executes an ITool directly and never touches the
 * loop, so a child reached over MCP was a tool server, not a sub-Agent.
 * `agent.ask` closes that gap: it pushes the prompt into THIS agent's own
 * execution loop (fresh isolated session) and resolves with the loop's
 * assistant answer. A parent whose mcp-client bridges a child's `agent.ask`
 * can therefore delegate cognition, not just tool calls.
 *
 * Purity: imports @openstarry/sdk (+zod) only.
 */

import { z } from "zod";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ITool,
  AgentEvent,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

interface AskInput {
  prompt: string;
  timeoutMs?: number;
}

/** Extract concatenated text segments from a MESSAGE_ASSISTANT payload. */
function extractAssistantText(payload: unknown): string | null {
  const message = (payload as { message?: { content?: unknown } } | undefined)?.message;
  if (!message || !Array.isArray(message.content)) return null;
  const texts = (message.content as Array<{ type?: string; text?: string }>)
    .filter((s) => s?.type === "text" && typeof s.text === "string")
    .map((s) => s.text as string);
  return texts.length > 0 ? texts.join("") : null;
}

function createAskTool(ctx: IPluginContext): ITool<AskInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.ask",
    description:
      "Ask THIS agent to think about a prompt and return its answer. Runs a " +
      "full cognition-loop round in an isolated session. Intended for " +
      "agent-to-agent delegation (e.g. exposed over MCP to a parent agent).",
    parameters: z.object({
      prompt: z.string().min(1).describe("The question or task to think about"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Answer deadline in ms (default ${DEFAULT_TIMEOUT_MS})`),
    }),

    async execute(input: AskInput): Promise<string> {
      const session = ctx.sessions.create({ source: "agent-ask" });
      const sessionId = session.id;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const unsubscribers: Array<() => void> = [];
      let timer: ReturnType<typeof setTimeout> | null = null;

      try {
        const answer = await new Promise<string>((resolve, reject) => {
          let lastAssistantText: string | null = null;

          unsubscribers.push(
            ctx.bus.on(AgentEventType.MESSAGE_ASSISTANT, (event: AgentEvent) => {
              const payload = event.payload as { sessionId?: string } | undefined;
              if (payload?.sessionId !== sessionId) return;
              const text = extractAssistantText(event.payload);
              if (text !== null) lastAssistantText = text;
            }),
          );

          unsubscribers.push(
            ctx.bus.on(AgentEventType.LOOP_FINISHED, (event: AgentEvent) => {
              const payload = event.payload as { sessionId?: string } | undefined;
              if (payload?.sessionId !== sessionId) return;
              resolve(lastAssistantText ?? "");
            }),
          );

          unsubscribers.push(
            ctx.bus.on(AgentEventType.LOOP_ERROR, (event: AgentEvent) => {
              const payload = event.payload as { sessionId?: string; error?: string } | undefined;
              if (payload?.sessionId !== sessionId) return;
              reject(new Error(`agent.ask: loop error — ${payload?.error ?? "unknown"}`));
            }),
          );

          timer = setTimeout(() => {
            reject(new Error(`agent.ask: no answer within ${timeoutMs}ms`));
          }, timeoutMs);

          ctx.pushInput({
            source: "agent-ask",
            inputType: "user_input",
            data: input.prompt,
            sessionId,
          });
        });

        return answer;
      } finally {
        if (timer !== null) clearTimeout(timer);
        for (const off of unsubscribers) {
          try { off(); } catch { /* best-effort */ }
        }
        try { ctx.sessions.destroy(sessionId); } catch { /* best-effort */ }
      }
    },
  };
}

export function createAgentAskPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/agent-ask",
      version: "0.1.0-alpha",
      description:
        "Exposes the agent's cognition loop as the `agent.ask` tool for agent-to-agent delegation (Tenet #10 fractal composition)",
      skandha: "samskara" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [createAskTool(ctx)],
      };
    },
  };
}

export default createAgentAskPlugin;
