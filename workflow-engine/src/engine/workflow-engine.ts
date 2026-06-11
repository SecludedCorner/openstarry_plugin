/**
 * Main workflow engine class.
 */

import { randomUUID } from "crypto";
import type { IPluginContext } from "@openstarry/sdk";
import type {
  IWorkflowDefinition,
  IWorkflowResult,
  IWorkflowStep,
  IWorkflowStartedPayload,
  IWorkflowStepStartedPayload,
  IWorkflowStepCompletedPayload,
  IWorkflowStepFailedPayload,
  IWorkflowCompletedPayload,
  IWorkflowErrorPayload,
} from "../types/workflow.js";
import {
  WORKFLOW_STARTED,
  WORKFLOW_STEP_STARTED,
  WORKFLOW_STEP_COMPLETED,
  WORKFLOW_STEP_FAILED,
  WORKFLOW_COMPLETED,
  WORKFLOW_ERROR,
} from "../types/workflow.js";
import { WorkflowExecutionError } from "../errors.js";
import { interpolate } from "./interpolate.js";
import { executeToolStep } from "./executors/tool-executor.js";
import { executeServiceStep } from "./executors/service-executor.js";
import { executeLLMStep } from "./executors/llm-executor.js";
import { executeCommandStep } from "./executors/command-executor.js";
import { executeInferenceStep } from "./executors/inference-executor.js";

/**
 * LRU cache for execution results (max 100 entries).
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  set(key: K, value: V): void {
    // Remove oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }
}

/**
 * Main workflow engine.
 */
export class WorkflowEngine {
  private ctx: IPluginContext;
  private loadedWorkflows = new Map<string, IWorkflowDefinition>();
  private executionCache = new LRUCache<string, IWorkflowResult>(100);

  constructor(ctx: IPluginContext) {
    this.ctx = ctx;
  }

  /**
   * Load a workflow definition (store in cache).
   *
   * @param path - Workflow file path (for caching key)
   * @param definition - Parsed workflow definition
   */
  loadWorkflow(path: string, definition: IWorkflowDefinition): void {
    this.loadedWorkflows.set(path, definition);
  }

  /**
   * Get a loaded workflow by path.
   */
  getWorkflow(path: string): IWorkflowDefinition | undefined {
    return this.loadedWorkflows.get(path);
  }

  /**
   * List all loaded workflows.
   */
  listWorkflows(): IWorkflowDefinition[] {
    return Array.from(this.loadedWorkflows.values());
  }

  /**
   * Execute a workflow with provided inputs.
   *
   * @param definition - Workflow definition
   * @param inputs - Input parameter values
   * @returns Execution result
   */
  async execute(
    definition: IWorkflowDefinition,
    inputs: Record<string, unknown>
  ): Promise<IWorkflowResult> {
    const executionId = randomUUID();
    const startTime = Date.now();

    // Initialize execution context
    const context: Record<string, unknown> = {
      inputs,
      steps: {},
    };

    // Emit workflow started event
    this.ctx.bus.emit({
      type: WORKFLOW_STARTED,
      timestamp: startTime,
      payload: {
        executionId,
        workflowName: definition.name,
        inputs,
      } satisfies IWorkflowStartedPayload,
    });

    try {
      // Execute steps sequentially
      for (const step of definition.steps) {
        const stepStartTime = Date.now();

        // Emit step started event
        this.ctx.bus.emit({
          type: WORKFLOW_STEP_STARTED,
          timestamp: stepStartTime,
          payload: {
            executionId,
            stepName: step.name,
            stepType: step.type,
          } satisfies IWorkflowStepStartedPayload,
        });

        try {
          // Execute step based on type
          const result = await this.executeStep(step, context, executionId);

          // Store result in context (always use step.name as key)
          (context.steps as Record<string, unknown>)[step.name] = result;

          // Emit step completed event
          this.ctx.bus.emit({
            type: WORKFLOW_STEP_COMPLETED,
            timestamp: Date.now(),
            payload: {
              executionId,
              stepName: step.name,
              output: result,
              durationMs: Date.now() - stepStartTime,
            } satisfies IWorkflowStepCompletedPayload,
          });
        } catch (error) {
          // Emit step failed event
          this.ctx.bus.emit({
            type: WORKFLOW_STEP_FAILED,
            timestamp: Date.now(),
            payload: {
              executionId,
              stepName: step.name,
              error: error instanceof Error ? error.message : String(error),
            } satisfies IWorkflowStepFailedPayload,
          });

          // Emit workflow error event
          this.ctx.bus.emit({
            type: WORKFLOW_ERROR,
            timestamp: Date.now(),
            payload: {
              executionId,
              workflowName: definition.name,
              error: error instanceof Error ? error.message : String(error),
              failedStep: step.name,
            } satisfies IWorkflowErrorPayload,
          });

          // Rethrow as WorkflowExecutionError if not already
          if (error instanceof WorkflowExecutionError) {
            throw error;
          }
          throw new WorkflowExecutionError(
            definition.name,
            executionId,
            error instanceof Error ? error.message : String(error),
            step.name,
            error
          );
        }
      }

      // Resolve output values
      const outputs: Record<string, unknown> = {};
      for (const [key, template] of Object.entries(definition.outputs)) {
        outputs[key] = interpolate(template, context);
      }

      const endTime = Date.now();

      // Emit workflow completed event
      this.ctx.bus.emit({
        type: WORKFLOW_COMPLETED,
        timestamp: endTime,
        payload: {
          executionId,
          workflowName: definition.name,
          outputs,
          durationMs: endTime - startTime,
        } satisfies IWorkflowCompletedPayload,
      });

      // Build result
      const result: IWorkflowResult = {
        executionId,
        workflowName: definition.name,
        workflowVersion: definition.version,
        status: "completed",
        outputs,
        metadata: {
          startTime,
          endTime,
          duration: endTime - startTime,
        },
      };

      // Cache result
      this.executionCache.set(executionId, result);

      return result;
    } catch (error) {
      const endTime = Date.now();

      // Build error result
      const result: IWorkflowResult = {
        executionId,
        workflowName: definition.name,
        workflowVersion: definition.version,
        status: "failed",
        outputs: {},
        error: {
          message: error instanceof Error ? error.message : String(error),
          step: error instanceof WorkflowExecutionError ? error.failedStep : undefined,
          cause: error,
        },
        metadata: {
          startTime,
          endTime,
          duration: endTime - startTime,
        },
      };

      // Cache result
      this.executionCache.set(executionId, result);

      throw error;
    }
  }

  /**
   * Get execution status from cache.
   */
  getStatus(executionId: string): IWorkflowResult | undefined {
    return this.executionCache.get(executionId);
  }

  /**
   * Execute a single step based on its type.
   */
  private async executeStep(
    step: IWorkflowStep,
    context: Record<string, unknown>,
    executionId: string
  ): Promise<unknown> {
    switch (step.type) {
      case "tool":
        return executeToolStep(step, context, this.ctx, executionId);
      case "service":
        return executeServiceStep(step, context, this.ctx, executionId);
      case "llm":
        return executeLLMStep(step, context, this.ctx, executionId);
      case "command":
        return executeCommandStep(step);
      case "inference":
        return executeInferenceStep(step, context, this.ctx, executionId);
      default: {
        // TypeScript exhaustiveness check
        const _exhaustiveCheck: never = step;
        throw new WorkflowExecutionError(
          "unknown",
          executionId,
          `Unknown step type: ${(_exhaustiveCheck as any).type}`,
          (_exhaustiveCheck as any).name
        );
      }
    }
  }
}
