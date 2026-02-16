/**
 * standard-core-commands — Provides the 4 built-in slash commands
 * previously hardcoded in AgentCore.
 *
 * Commands:
 * - /help    — List all registered commands
 * - /reset   — Reset conversation history for the current session
 * - /quit    — Stop the agent
 * - /metrics — Show current metrics snapshot
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  SlashCommand,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

export function createCoreCommandsPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/standard-core-commands",
      version: "0.1.0-alpha",
      description: "Built-in slash commands: help, reset, quit, metrics",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const commands: SlashCommand[] = [
        {
          name: "help",
          description: "Show available commands",
          async execute(_args: string, _ctx: IPluginContext): Promise<string> {
            const cmds = ctx.commands?.list() ?? [];
            const lines = cmds.map((c) => `  /${c.name} — ${c.description}`);
            return "Available commands:\n" + lines.join("\n");
          },
        },

        {
          name: "reset",
          description: "Reset conversation history",
          async execute(_args: string, _ctx: IPluginContext, sessionId?: string): Promise<string> {
            ctx.sessions.getStateManager(sessionId).clear();
            ctx.bus.emit({
              type: AgentEventType.STATE_RESET,
              timestamp: Date.now(),
            });
            return "Conversation reset.";
          },
        },

        {
          name: "quit",
          description: "Exit the agent",
          async execute(): Promise<string> {
            ctx.bus.emit({
              type: AgentEventType.AGENT_STOPPED,
              timestamp: Date.now(),
            });
            return "__QUIT__";
          },
        },

        {
          name: "metrics",
          description: "Show current metrics snapshot",
          async execute(): Promise<string> {
            const snapshot = ctx.metrics?.getSnapshot() as
              | { counters: Record<string, number>; gauges: Record<string, number> }
              | undefined;

            if (!snapshot) {
              return "Metrics not available.";
            }

            ctx.bus.emit({
              type: AgentEventType.METRICS_SNAPSHOT,
              timestamp: Date.now(),
              payload: snapshot,
            });

            const counterLines = Object.entries(snapshot.counters ?? {})
              .map(([name, value]) => `  ${name}: ${value}`)
              .join("\n");
            const gaugeLines = Object.entries(snapshot.gauges ?? {})
              .map(([name, value]) => `  ${name}: ${value}`)
              .join("\n");

            let result = "Metrics Snapshot:\n";
            if (counterLines) {
              result += "\nCounters:\n" + counterLines;
            }
            if (gaugeLines) {
              result += "\nGauges:\n" + gaugeLines;
            }
            if (!counterLines && !gaugeLines) {
              result += "\n  (no metrics recorded yet)";
            }

            return result;
          },
        },
      ];

      return { commands };
    },
  };
}

export default createCoreCommandsPlugin;
