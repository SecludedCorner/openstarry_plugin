/**
 * Main workflow engine class.
 */

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IPluginContext } from "@openstarry/sdk";
import type {
  IWorkflowDefinition,
  IWorkflowResult,
  IWorkflowStep,
  ILoopStep,
  ILoopIterationRecord,
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
 * Resolve a dot-path against the execution context to the RAW value
 * (Mustache renders strings only — loop `over` needs the actual array).
 * Accepts either a single-tag template ("{{inputs.items}}") or a bare path.
 */
export function resolveContextPath(context: Record<string, unknown>, ref: string): unknown {
  const singleTag = /^\s*\{\{\s*([\w.[\]$-]+)\s*\}\}\s*$/.exec(ref);
  const path = (singleTag ? singleTag[1] : ref).trim();
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = context;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Engine construction options (DT-MG-β, added v0.58.0-alpha).
 */
export interface WorkflowEngineOptions {
  /**
   * Directory for persisted execution results. When set, every execution
   * result (success AND failure) is written to `<persistDir>/<executionId>.json`
   * and `getStatus()` falls back to disk on LRU-cache miss — execution state
   * survives the process. When unset, behavior is the pre-v0.58 in-memory MVP.
   */
  readonly persistDir?: string;
}

/**
 * Main workflow engine.
 */
export class WorkflowEngine {
  private ctx: IPluginContext;
  private loadedWorkflows = new Map<string, IWorkflowDefinition>();
  private executionCache = new LRUCache<string, IWorkflowResult>(100);
  private readonly persistDir: string | undefined;

  constructor(ctx: IPluginContext, options: WorkflowEngineOptions = {}) {
    this.ctx = ctx;
    this.persistDir = options.persistDir;
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
      // Execute steps sequentially (extracted to runSteps so loop steps can
      // recurse over their nested step lists — DT-MG-α).
      await this.runSteps(definition.steps, context, executionId, definition.name);

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

      // Cache + persist result (DT-MG-β)
      this.executionCache.set(executionId, result);
      this.persistResult(result);

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

      // Cache + persist result (DT-MG-β — failures persist too, so a crashed
      // run is diagnosable after the process exits)
      this.executionCache.set(executionId, result);
      this.persistResult(result);

      throw error;
    }
  }

  /**
   * Get execution status from cache, falling back to the persist directory
   * when configured (DT-MG-β) — status survives the process that ran it.
   */
  getStatus(executionId: string): IWorkflowResult | undefined {
    const cached = this.executionCache.get(executionId);
    if (cached) return cached;
    if (!this.persistDir || !/^[\w-]+$/.test(executionId)) return undefined;
    try {
      const raw = readFileSync(join(this.persistDir, `${executionId}.json`), "utf-8");
      const parsed = JSON.parse(raw) as IWorkflowResult;
      this.executionCache.set(executionId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Run a list of steps sequentially against the shared context, emitting
   * the standard step lifecycle events. Used by execute() for top-level
   * steps and by executeLoopStep() for nested iteration bodies (DT-MG-α).
   */
  private async runSteps(
    steps: IWorkflowStep[],
    context: Record<string, unknown>,
    executionId: string,
    workflowName: string,
  ): Promise<void> {
    for (const step of steps) {
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
        const result = await this.executeStep(step, context, executionId, workflowName);

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
            workflowName,
            error: error instanceof Error ? error.message : String(error),
            failedStep: step.name,
          } satisfies IWorkflowErrorPayload,
        });

        // Rethrow as WorkflowExecutionError if not already
        if (error instanceof WorkflowExecutionError) {
          throw error;
        }
        throw new WorkflowExecutionError(
          workflowName,
          executionId,
          error instanceof Error ? error.message : String(error),
          step.name,
          error
        );
      }
    }
  }

  /**
   * Execute a loop step (DT-MG-α). Foreach mode iterates a context array;
   * while mode re-renders the condition template before each iteration and
   * continues while it renders to exactly "true". maxIterations is a hard
   * cap in BOTH modes — exceeding it throws (no silent truncation).
   */
  private async executeLoopStep(
    step: ILoopStep,
    context: Record<string, unknown>,
    executionId: string,
    workflowName: string,
  ): Promise<ILoopIterationRecord[]> {
    const hasOver = typeof step.over === "string";
    const hasWhile = typeof step.while === "string";
    if (hasOver === hasWhile) {
      throw new WorkflowExecutionError(
        workflowName,
        executionId,
        "loop step requires exactly one of 'over' (foreach) or 'while' (condition)",
        step.name,
      );
    }

    const iterations: ILoopIterationRecord[] = [];
    const snapshotInner = (): Record<string, unknown> => {
      const snapshot: Record<string, unknown> = {};
      const stepsCtx = context.steps as Record<string, unknown>;
      for (const inner of step.steps) snapshot[inner.name] = stepsCtx[inner.name];
      return snapshot;
    };

    try {
      if (hasOver) {
        const resolved = resolveContextPath(context, step.over!);
        if (!Array.isArray(resolved)) {
          throw new WorkflowExecutionError(
            workflowName,
            executionId,
            `loop 'over' path "${step.over}" did not resolve to an array (got ${resolved === null ? "null" : typeof resolved})`,
            step.name,
          );
        }
        if (resolved.length > step.maxIterations) {
          throw new WorkflowExecutionError(
            workflowName,
            executionId,
            `loop 'over' array length ${resolved.length} exceeds maxIterations ${step.maxIterations} — refusing to truncate silently`,
            step.name,
          );
        }
        for (let i = 0; i < resolved.length; i++) {
          context.loop = { index: i, item: resolved[i] };
          await this.runSteps(step.steps, context, executionId, workflowName);
          iterations.push({ index: i, item: resolved[i], steps: snapshotInner() });
        }
      } else {
        let i = 0;
        for (;;) {
          const rendered = interpolate(step.while!, context);
          if (String(rendered).trim() !== "true") break;
          if (i >= step.maxIterations) {
            throw new WorkflowExecutionError(
              workflowName,
              executionId,
              `loop 'while' condition still true after maxIterations ${step.maxIterations} — aborting (non-convergent loop)`,
              step.name,
            );
          }
          context.loop = { index: i };
          await this.runSteps(step.steps, context, executionId, workflowName);
          iterations.push({ index: i, steps: snapshotInner() });
          i++;
        }
      }
    } finally {
      delete context.loop;
    }

    return iterations;
  }

  /**
   * Persist an execution result to the configured directory (DT-MG-β).
   * Best-effort: persistence failure must never fail the workflow itself.
   */
  private persistResult(result: IWorkflowResult): void {
    if (!this.persistDir) return;
    try {
      mkdirSync(this.persistDir, { recursive: true });
      let serialized: string;
      try {
        serialized = JSON.stringify(result, (key, value) =>
          value instanceof Error ? { name: value.name, message: value.message } : value,
        );
      } catch {
        // Non-serializable cause chain — strip it and persist the rest.
        serialized = JSON.stringify({ ...result, error: result.error ? { message: result.error.message, step: result.error.step } : undefined });
      }
      writeFileSync(join(this.persistDir, `${result.executionId}.json`), serialized, "utf-8");
    } catch {
      // Best-effort by design.
    }
  }

  /**
   * Execute a single step based on its type.
   */
  private async executeStep(
    step: IWorkflowStep,
    context: Record<string, unknown>,
    executionId: string,
    workflowName: string,
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
      case "loop":
        return this.executeLoopStep(step, context, executionId, workflowName);
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
