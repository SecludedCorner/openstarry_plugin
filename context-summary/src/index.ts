import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { ContextSummaryManager } from "./context-summary.js";
import type { ContextSummaryConfig } from "./types.js";

export type { ContextSummaryConfig } from "./types.js";
export { ContextSummaryManager } from "./context-summary.js";
export { estimateTokens, estimateMessagesTokens } from "./token-estimator.js";

export function createContextSummaryPlugin(
  config: ContextSummaryConfig = {},
): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/context-summary",
      version: "0.1.0-alpha",
      description:
        "Summary-based context management strategy — compresses older turns via LLM summarization, falls back to sliding-window gracefully (samjna)",
      skandha: "samjna",
      criticality: "optional-degraded",
      dependencies: [],
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const contextManager = new ContextSummaryManager(config, ctx);
      return { contextManager };
    },
  };
}
