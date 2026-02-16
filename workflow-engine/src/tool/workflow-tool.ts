/**
 * ITool implementation for workflow execution.
 */

import { z } from "zod";
import type { ITool } from "@openstarry/sdk";
import type { WorkflowEngine } from "../engine/workflow-engine.js";
import type { IWorkflowService } from "../service/workflow-service.js";
import { createWorkflowService } from "../service/workflow-service.js";

/**
 * Tool input schema.
 */
const WorkflowToolInputSchema = z.object({
  workflowPath: z.string().describe("Path to workflow YAML file or workflow name"),
  inputs: z.record(z.unknown()).optional().describe("Workflow input parameters"),
});

type WorkflowToolInput = z.infer<typeof WorkflowToolInputSchema>;

/**
 * Create workflow:execute tool.
 */
export function createWorkflowTool(engine: WorkflowEngine): ITool {
  const service = createWorkflowService(engine);

  return {
    id: "workflow:execute",
    description: "Execute a declarative workflow from a YAML file. Supports multi-step orchestration with tool, service, and LLM steps.",
    parameters: WorkflowToolInputSchema as any,

    async execute(input: WorkflowToolInput): Promise<string> {
      try {
        const result = await service.execute(input.workflowPath, input.inputs ?? {});

        if (result.status === "completed") {
          return JSON.stringify({
            executionId: result.executionId,
            status: result.status,
            outputs: result.outputs,
            duration: result.metadata.duration,
          }, null, 2);
        } else {
          return JSON.stringify({
            executionId: result.executionId,
            status: result.status,
            error: result.error,
            duration: result.metadata.duration,
          }, null, 2);
        }
      } catch (error) {
        return JSON.stringify({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }, null, 2);
      }
    },
  };
}
