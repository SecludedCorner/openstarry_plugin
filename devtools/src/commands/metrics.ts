/**
 * /metrics slash command — print current metrics snapshot.
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { IMetricsCollector } from "../types/state.js";
import { formatMetricsSnapshot } from "../state/formatter.js";

export function createMetricsCommand(collector: IMetricsCollector): SlashCommand {
  return {
    name: "metrics",
    description: "Display current metrics snapshot",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      const snapshot = collector.getSnapshot();
      return formatMetricsSnapshot(snapshot);
    },
  };
}
