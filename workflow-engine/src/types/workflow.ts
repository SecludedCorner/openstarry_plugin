/**
 * Workflow type definitions (frozen interfaces from Architecture Spec).
 */

/**
 * Complete workflow definition (YAML parsed and validated).
 */
export interface IWorkflowDefinition {
  /** Workflow name (unique identifier, kebab-case recommended) */
  name: string;

  /** Semver version string */
  version: string;

  /** Human-readable description (optional) */
  description?: string;

  /** Input parameter schema */
  inputs: Record<string, IWorkflowInput>;

  /** Ordered list of workflow steps (sequential execution) */
  steps: IWorkflowStep[];

  /** Output value mappings (Mustache templates referencing step outputs) */
  outputs: Record<string, string>;

  /** Optional metadata (for future extensions) */
  metadata?: {
    author?: string;
    tags?: string[];
    [key: string]: unknown;
  };
}

/**
 * Input parameter definition.
 */
export interface IWorkflowInput {
  /** Parameter type (simple type hints for documentation) */
  type: "string" | "number" | "boolean" | "object" | "array";

  /** Whether parameter is required */
  required: boolean;

  /** Default value (optional) */
  default?: unknown;

  /** Description (optional) */
  description?: string;
}

/**
 * Base interface for all workflow steps.
 * Discriminated union via `type` field.
 */
export interface IWorkflowStepBase {
  /** Step name (unique within workflow, kebab-case recommended) */
  name: string;

  /** Step type discriminator */
  type: "tool" | "service" | "llm" | "command" | "inference";

  /** Output variable name (optional, default: steps.<name>) */
  output?: string;
}

/**
 * Tool step — invokes a registered ITool.
 */
export interface IToolStep extends IWorkflowStepBase {
  type: "tool";

  /** Tool ID (e.g., "fs:read", "api:get") */
  tool: string;

  /** Tool arguments (supports Mustache templates) */
  arguments: Record<string, unknown>;
}

/**
 * Service step — calls a plugin service method.
 */
export interface IServiceStep extends IWorkflowStepBase {
  type: "service";

  /** Service name (e.g., "skill-parser") */
  service: string;

  /** Method name to invoke on service */
  method: string;

  /** Method arguments (array, supports Mustache templates) */
  arguments: unknown[];
}

/**
 * LLM step — direct LLM provider invocation.
 */
export interface ILLMStep extends IWorkflowStepBase {
  type: "llm";

  /** Provider ID (e.g., "anthropic", "openai") */
  provider: string;

  /** Prompt template (supports Mustache templates) */
  prompt: string;

  /** Optional model override */
  model?: string;

  /** Optional temperature override */
  temperature?: number;

  /** Optional max tokens */
  maxTokens?: number;
}

/**
 * Command step — executes a slash command.
 * NOTE: Command steps are NOT SUPPORTED in MVP (will throw error).
 * This interface is defined for future compatibility.
 */
export interface ICommandStep extends IWorkflowStepBase {
  type: "command";

  /** Command name (without leading slash) */
  command: string;

  /** Command arguments string (supports Mustache templates) */
  args: string;
}

/**
 * Inference step — invokes an IInferenceProvider directly.
 */
export interface IInferenceStep extends IWorkflowStepBase {
  type: "inference";

  /** Provider ID (must implement IInferenceProvider). */
  provider: string;

  /** Optional model override (default: first model in provider). */
  model?: string;

  /** Inference input definition (supports Mustache templates in values). */
  input: {
    type: "image" | "tensor" | "text" | "raw";
    [key: string]: unknown;
  };

  /** Optional provider-specific options. */
  options?: Record<string, unknown>;
}

/**
 * Discriminated union of all step types.
 */
export type IWorkflowStep = IToolStep | IServiceStep | ILLMStep | ICommandStep | IInferenceStep;

/**
 * Workflow execution result.
 */
export interface IWorkflowResult {
  /** Unique execution ID (UUID v4) */
  executionId: string;

  /** Workflow name that was executed */
  workflowName: string;

  /** Workflow version */
  workflowVersion: string;

  /** Execution status */
  status: "completed" | "failed";

  /** Resolved output values (from workflow.outputs mapping) */
  outputs: Record<string, unknown>;

  /** Error information (if status === "failed") */
  error?: {
    message: string;
    step?: string; // Step name where error occurred
    cause?: unknown; // Original error object (serialized)
  };

  /** Execution metadata */
  metadata: {
    startTime: number; // Unix timestamp (ms)
    endTime: number; // Unix timestamp (ms)
    duration: number; // Duration in milliseconds
  };
}

/**
 * Workflow event payload types.
 */
export interface IWorkflowStartedPayload {
  executionId: string;
  workflowName: string;
  inputs: Record<string, unknown>;
}

export interface IWorkflowStepStartedPayload {
  executionId: string;
  stepName: string;
  stepType: string;
}

export interface IWorkflowStepCompletedPayload {
  executionId: string;
  stepName: string;
  output: unknown;
  durationMs: number;
}

export interface IWorkflowStepFailedPayload {
  executionId: string;
  stepName: string;
  error: string;
}

export interface IWorkflowCompletedPayload {
  executionId: string;
  workflowName: string;
  outputs: Record<string, unknown>;
  durationMs: number;
}

export interface IWorkflowErrorPayload {
  executionId: string;
  workflowName: string;
  error: string;
  failedStep?: string;
}

/**
 * Workflow event type constants.
 */
export const WORKFLOW_STARTED = "workflow:started";
export const WORKFLOW_STEP_STARTED = "workflow:step_started";
export const WORKFLOW_STEP_COMPLETED = "workflow:step_completed";
export const WORKFLOW_STEP_FAILED = "workflow:step_failed";
export const WORKFLOW_COMPLETED = "workflow:completed";
export const WORKFLOW_ERROR = "workflow:error";
