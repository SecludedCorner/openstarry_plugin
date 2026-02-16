/**
 * IWorkflowService implementation.
 */

import { readFile } from "fs/promises";
import { parse as parseYAML } from "yaml";
import type { IPluginService } from "@openstarry/sdk";
import type { IWorkflowDefinition, IWorkflowResult } from "../types/workflow.js";
import { WorkflowSchema } from "../schema/workflow-schema.js";
import { WorkflowLoadError, WorkflowExecutionError } from "../errors.js";
import { WorkflowEngine } from "../engine/workflow-engine.js";

/**
 * Workflow engine service interface.
 */
export interface IWorkflowService extends IPluginService {
  name: "workflow-engine";
  version: string;

  load(path: string): Promise<IWorkflowDefinition>;
  execute(workflowId: string, inputs: Record<string, unknown>): Promise<IWorkflowResult>;
  getStatus(executionId: string): IWorkflowResult | undefined;
  list(): IWorkflowDefinition[];
}

/**
 * Create workflow service instance.
 */
export function createWorkflowService(engine: WorkflowEngine): IWorkflowService {
  return {
    name: "workflow-engine",
    version: "0.18.0",

    async load(path: string): Promise<IWorkflowDefinition> {
      try {
        // Read YAML file
        const content = await readFile(path, "utf-8");

        // Parse YAML
        let parsed: unknown;
        try {
          parsed = parseYAML(content);
        } catch (error) {
          throw new WorkflowLoadError(
            path,
            `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
            error
          );
        }

        // Validate with Zod schema
        const result = WorkflowSchema.safeParse(parsed);
        if (!result.success) {
          throw new WorkflowLoadError(
            path,
            `Schema validation failed: ${result.error.message}`,
            result.error
          );
        }

        const definition = result.data as IWorkflowDefinition;

        // Cache the loaded workflow
        engine.loadWorkflow(path, definition);

        return definition;
      } catch (error) {
        if (error instanceof WorkflowLoadError) {
          throw error;
        }
        throw new WorkflowLoadError(
          path,
          `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    },

    async execute(workflowId: string, inputs: Record<string, unknown>): Promise<IWorkflowResult> {
      // Try to get workflow by path first
      let definition = engine.getWorkflow(workflowId);

      // If not found, try to load it
      if (!definition) {
        try {
          definition = await this.load(workflowId);
        } catch (error) {
          // Check if it's a workflow name instead of path
          const allWorkflows = engine.listWorkflows();
          definition = allWorkflows.find((w) => w.name === workflowId);

          if (!definition) {
            throw new WorkflowExecutionError(
              workflowId,
              "unknown",
              `Workflow not found by path or name: ${workflowId}`
            );
          }
        }
      }

      // Execute workflow
      return engine.execute(definition, inputs);
    },

    getStatus(executionId: string): IWorkflowResult | undefined {
      return engine.getStatus(executionId);
    },

    list(): IWorkflowDefinition[] {
      return engine.listWorkflows();
    },
  };
}
