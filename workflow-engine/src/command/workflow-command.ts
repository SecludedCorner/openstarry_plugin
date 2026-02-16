/**
 * SlashCommand implementation for workflow execution.
 */

import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { WorkflowEngine } from "../engine/workflow-engine.js";
import { createWorkflowService } from "../service/workflow-service.js";

/**
 * Create /workflow slash command.
 */
export function createWorkflowCommand(engine: WorkflowEngine, ctx: IPluginContext): SlashCommand {
  const service = createWorkflowService(engine);

  return {
    name: "workflow",
    description: "Execute a workflow from a YAML file. Usage: /workflow <path> [key=value ...]",

    async execute(args: string): Promise<string> {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) {
        return "Usage: /workflow <path> [key=value ...]\nExample: /workflow ./my-workflow.yaml dataPath=/data/input.csv";
      }

      const workflowPath = parts[0];
      const inputs: Record<string, unknown> = {};

      // Parse key=value arguments
      for (let i = 1; i < parts.length; i++) {
        const match = parts[i].match(/^([^=]+)=(.+)$/);
        if (match) {
          const [, key, value] = match;
          // Simple type coercion
          if (value === "true") inputs[key] = true;
          else if (value === "false") inputs[key] = false;
          else if (/^\d+$/.test(value)) inputs[key] = parseInt(value, 10);
          else if (/^\d+\.\d+$/.test(value)) inputs[key] = parseFloat(value);
          else inputs[key] = value;
        }
      }

      try {
        const result = await service.execute(workflowPath, inputs);

        if (result.status === "completed") {
          return [
            `✓ Workflow completed: ${result.workflowName} v${result.workflowVersion}`,
            `  Execution ID: ${result.executionId}`,
            `  Duration: ${result.metadata.duration}ms`,
            `  Outputs:`,
            ...Object.entries(result.outputs).map(([key, value]) =>
              `    ${key}: ${JSON.stringify(value)}`
            ),
          ].join("\n");
        } else {
          return [
            `✗ Workflow failed: ${result.workflowName} v${result.workflowVersion}`,
            `  Execution ID: ${result.executionId}`,
            `  Error: ${result.error?.message}`,
            result.error?.step ? `  Failed step: ${result.error.step}` : "",
          ].filter(Boolean).join("\n");
        }
      } catch (error) {
        return `✗ Workflow execution error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
