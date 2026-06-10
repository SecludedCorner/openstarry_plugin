/**
 * Custom error classes for workflow engine.
 */

/**
 * Error thrown when workflow file cannot be loaded or parsed.
 */
export class WorkflowLoadError extends Error {
  constructor(
    public readonly path: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(`Workflow load failed for "${path}": ${message}`);
    this.name = "WorkflowLoadError";
  }
}

/**
 * Error thrown when workflow execution fails.
 */
export class WorkflowExecutionError extends Error {
  constructor(
    public readonly workflowName: string,
    public readonly executionId: string,
    message: string,
    public readonly failedStep?: string,
    public readonly cause?: unknown
  ) {
    super(
      `Workflow execution failed for "${workflowName}" (${executionId}): ${message}` +
      (failedStep ? ` at step "${failedStep}"` : "")
    );
    this.name = "WorkflowExecutionError";
  }
}

/**
 * Error thrown when variable interpolation fails.
 */
export class VariableInterpolationError extends Error {
  constructor(
    public readonly template: string,
    public readonly context: Record<string, unknown>,
    message: string
  ) {
    super(`Variable interpolation failed for template "${template}": ${message}`);
    this.name = "VariableInterpolationError";
  }
}

/**
 * Error thrown when command step is encountered (not supported in MVP).
 */
export class CommandStepNotSupportedError extends Error {
  constructor(public readonly stepName: string) {
    super(
      `Command step "${stepName}" is not supported in MVP. ` +
      `Command steps require ctx.commands accessor, which is not yet available in IPluginContext. ` +
      `This feature is planned for v0.18.1.`
    );
    this.name = "CommandStepNotSupportedError";
  }
}
