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
import { createWorkflowStatusTool } from "./tool/workflow-status-tool.js";
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
      // Initialize engine with plugin context.
      // DT-MG-β (v0.58.0-alpha): opt-in execution-state persistence — set
      // OPENSTARRY_WORKFLOW_STATE_DIR to persist every result JSON to disk
      // and make getStatus() survive the process. Unset = pre-v0.58 MVP.
      const persistDir = process.env["OPENSTARRY_WORKFLOW_STATE_DIR"];
      const engine = new WorkflowEngine(
        ctx,
        persistDir && persistDir.length > 0 ? { persistDir } : {},
      );

      // Register as service for other plugins
      const service = createWorkflowService(engine);
      ctx.services?.register(service);

      // Create tools for LLM invocation: execute + status (Doc 12 poll-handle).
      const tool = createWorkflowTool(engine);
      const statusTool = createWorkflowStatusTool(engine);

      // Create slash command for CLI usage
      const command = createWorkflowCommand(engine, ctx);

      return {
        tools: [tool, statusTool],
        commands: [command],
        dispose: async () => {
          // In-memory state is ephemeral; with OPENSTARRY_WORKFLOW_STATE_DIR
          // set, results are already on disk (written synchronously at
          // completion/failure) — nothing to flush here.
        },
      };
    },
  };
}
