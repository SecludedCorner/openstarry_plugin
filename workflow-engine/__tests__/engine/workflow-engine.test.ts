/**
 * Workflow engine lifecycle tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { IPluginContext, ITool, IProvider } from "@openstarry/sdk";
import { WorkflowEngine } from "../../src/engine/workflow-engine.js";
import type { IWorkflowDefinition } from "../../src/types/workflow.js";

// Mock plugin context
function createMockContext(): IPluginContext {
  const mockTool: ITool = {
    id: "test:tool",
    description: "Test tool",
    parameters: {} as any,
    async execute() {
      return "tool result";
    },
  };

  const mockProvider: IProvider = {
    id: "test-provider",
    name: "Test Provider",
    async chat() {
      return { message: { role: "assistant", content: "LLM response" } };
    },
  };

  return {
    bus: {
      emit: () => {},
      subscribe: () => () => {},
    },
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    tools: {
      list: () => [mockTool],
      get: (id: string) => (id === "test:tool" ? mockTool : undefined),
    },
    providers: {
      list: () => [mockProvider],
      get: (id: string) => (id === "test-provider" ? mockProvider : undefined),
    },
    services: {
      register: () => {},
      get: () => undefined,
      has: () => false,
      list: () => [],
    },
  };
}

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;
  let ctx: IPluginContext;

  beforeEach(() => {
    ctx = createMockContext();
    engine = new WorkflowEngine(ctx);
  });

  it("should load and cache workflow definitions", () => {
    const definition: IWorkflowDefinition = {
      name: "test-workflow",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "step1", type: "tool", tool: "test:tool", arguments: {} },
      ],
      outputs: { result: "{{ steps.step1 }}" },
    };

    engine.loadWorkflow("/test/workflow.yaml", definition);

    const loaded = engine.getWorkflow("/test/workflow.yaml");
    expect(loaded).toEqual(definition);
  });

  it("should list all loaded workflows", () => {
    const def1: IWorkflowDefinition = {
      name: "workflow-1",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "tool", tool: "test:tool", arguments: {} }],
      outputs: {},
    };

    const def2: IWorkflowDefinition = {
      name: "workflow-2",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "tool", tool: "test:tool", arguments: {} }],
      outputs: {},
    };

    engine.loadWorkflow("/test/wf1.yaml", def1);
    engine.loadWorkflow("/test/wf2.yaml", def2);

    const list = engine.listWorkflows();
    expect(list).toHaveLength(2);
    expect(list).toContain(def1);
    expect(list).toContain(def2);
  });

  it("should execute workflow and return result", async () => {
    const definition: IWorkflowDefinition = {
      name: "simple-workflow",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "call-tool", type: "tool", tool: "test:tool", arguments: {} },
      ],
      outputs: { result: "{{ steps.call-tool }}" },
    };

    const result = await engine.execute(definition, {});

    expect(result.status).toBe("completed");
    expect(result.workflowName).toBe("simple-workflow");
    expect(result.outputs.result).toBe("tool result");
    expect(result.executionId).toBeDefined();
  });

  it("should cache execution results", async () => {
    const definition: IWorkflowDefinition = {
      name: "test",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "tool", tool: "test:tool", arguments: {} }],
      outputs: {},
    };

    const result = await engine.execute(definition, {});
    const cached = engine.getStatus(result.executionId);

    expect(cached).toEqual(result);
  });

  it("should return undefined for non-existent execution ID", () => {
    const status = engine.getStatus("non-existent-id");
    expect(status).toBeUndefined();
  });
});
