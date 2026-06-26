/**
 * ITool implementation for workflow status lookup.
 *
 * Doc 12 §workflow:status — the async poll-handle half of the workflow tool
 * surface. workflow:execute returns an executionId; this tool lets an agent
 * (not just a downstream code path) look that run's status/outputs/error back
 * up by id. Backed by the already-shipped WorkflowEngine.getStatus, which (with
 * OPENSTARRY_WORKFLOW_STATE_DIR set) survives a process restart via disk.
 *
 * NEW IN v0.59.7 (Doc 12 closure).
 */

import { z } from "zod";
import type { ITool } from "@openstarry/sdk";
import type { WorkflowEngine } from "../engine/workflow-engine.js";
import { createWorkflowService } from "../service/workflow-service.js";

const WorkflowStatusInputSchema = z.object({
  executionId: z.string().describe("The executionId returned by a prior workflow:execute call"),
});

type WorkflowStatusInput = z.infer<typeof WorkflowStatusInputSchema>;

/**
 * Create workflow:status tool.
 */
export function createWorkflowStatusTool(engine: WorkflowEngine): ITool {
  const service = createWorkflowService(engine);

  return {
    skandha: 'samskara' as const,
    id: "workflow:status",
    description:
      "Look up a previously-started workflow run by its executionId (returned by workflow:execute). " +
      "Returns the stored status (completed/failed), outputs or error, and duration — or a not-found message.",
    parameters: WorkflowStatusInputSchema as any,

    async execute(input: WorkflowStatusInput): Promise<string> {
      const result = service.getStatus(input.executionId);
      if (!result) {
        return JSON.stringify({
          executionId: input.executionId,
          status: "not_found",
          message: `No workflow execution found for id '${input.executionId}'`,
        }, null, 2);
      }
      return JSON.stringify({
        executionId: result.executionId,
        status: result.status,
        ...(result.status === "completed" ? { outputs: result.outputs } : { error: result.error }),
        duration: result.metadata?.duration,
      }, null, 2);
    },
  };
}
