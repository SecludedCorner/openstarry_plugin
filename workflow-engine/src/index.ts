/**
 * Workflow Engine Plugin — MVP implementation.
 *
 * Five Aggregates Mapping: ITool (行蘊) — Executable workflows
 * Also registers as IPluginService for cross-plugin integration.
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { WorkflowEngine } from "./engine/workflow-engine.js";
import { createWorkflowService } from "./service/workflow-service.js";
import { createWorkflowTool } from "./tool/workflow-tool.js";
import { createWorkflowCommand } from "./command/workflow-command.js";

/**
 * Re-export public types and errors.
 */
export * from "./types/workflow.js";
export * from "./errors.js";
export type { IWorkflowService } from "./service/workflow-service.js";

/**
 * Create workflow engine plugin.
 */
export function createWorkflowEnginePlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/workflow-engine",
      version: "0.18.0",
      description: "Declarative multi-step workflow orchestration (MVP)",
      author: "OpenStarry Team",
      services: ["workflow-engine"],
      serviceDependencies: [], // Optional: skill-parser, fs:read, etc.
      skandha: 'samskara' as const,
    },

    factory: async (ctx: IPluginContext): Promise<PluginHooks> => {
      // Initialize engine with plugin context
      const engine = new WorkflowEngine(ctx);

      // Register as service for other plugins
      const service = createWorkflowService(engine);
      ctx.services?.register(service);

      // Create tool for LLM invocation
      const tool = createWorkflowTool(engine);

      // Create slash command for CLI usage
      const command = createWorkflowCommand(engine, ctx);

      return {
        tools: [tool],
        commands: [command],
        dispose: async () => {
          // No cleanup needed in MVP (ephemeral execution)
        },
      };
    },
  };
}
