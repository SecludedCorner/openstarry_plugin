/**
 * Tool step executor.
 */

import type { IPluginContext } from "@openstarry/sdk";
import type { IToolStep } from "../../types/workflow.js";
import { WorkflowExecutionError } from "../../errors.js";
import { interpolate } from "../interpolate.js";

/**
 * Execute a tool step.
 *
 * @param step - Tool step definition
 * @param context - Execution context with interpolated variables
 * @param pluginCtx - Plugin context
 * @param executionId - Current execution ID
 * @returns Tool execution result
 */
export async function executeToolStep(
  step: IToolStep,
  context: Record<string, unknown>,
  pluginCtx: IPluginContext,
  executionId: string
): Promise<unknown> {
  // Interpolate arguments
  const interpolatedArgs = interpolate(step.arguments, context) as Record<string, unknown>;

  // Get tool from registry
  const tool = pluginCtx.tools?.get(step.tool);
  if (!tool) {
    const availableTools = pluginCtx.tools?.list().map((t) => t.id) || [];
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Tool "${step.tool}" not found. Available tools: ${availableTools.join(", ") || "none"}`,
      step.name
    );
  }

  // Execute tool
  try {
    const result = await tool.execute(interpolatedArgs, {
      workingDirectory: pluginCtx.workingDirectory,
      allowedPaths: [pluginCtx.workingDirectory],
      bus: pluginCtx.bus,
    });
    return result;
  } catch (error) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      step.name,
      error
    );
  }
}
