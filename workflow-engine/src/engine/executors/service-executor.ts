/**
 * Service step executor.
 */

import type { IPluginContext } from "@openstarry/sdk";
import { ServiceKey } from "@openstarry/sdk";
import type { IServiceStep } from "../../types/workflow.js";
import { WorkflowExecutionError } from "../../errors.js";
import { interpolate } from "../interpolate.js";

/**
 * Execute a service step.
 *
 * @param step - Service step definition
 * @param context - Execution context with interpolated variables
 * @param pluginCtx - Plugin context
 * @param executionId - Current execution ID
 * @returns Service method result
 */
export async function executeServiceStep(
  step: IServiceStep,
  context: Record<string, unknown>,
  pluginCtx: IPluginContext,
  executionId: string
): Promise<unknown> {
  // Interpolate arguments
  const interpolatedArgs = interpolate(step.arguments, context) as unknown[];

  // Get service from registry
  const service = pluginCtx.services?.get(new ServiceKey<any>(step.service));
  if (!service) {
    // Soft warning per spec: log and return undefined
    console.warn(
      `[workflow-engine] Service "${step.service}" not found for step "${step.name}". Continuing with undefined output.`
    );
    return undefined;
  }

  // Verify method exists
  if (typeof service[step.method] !== "function") {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Service "${step.service}" does not have method "${step.method}"`,
      step.name
    );
  }

  // Execute service method
  try {
    const result = await service[step.method](...interpolatedArgs);
    return result;
  } catch (error) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Service method failed: ${error instanceof Error ? error.message : String(error)}`,
      step.name,
      error
    );
  }
}
