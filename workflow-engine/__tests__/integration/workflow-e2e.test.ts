/**
 * End-to-end integration tests.
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, ITool, IProvider } from "@openstarry/sdk";
import { WorkflowEngine } from "../../src/engine/workflow-engine.js";
import { createWorkflowService } from "../../src/service/workflow-service.js";
import type { IWorkflowDefinition } from "../../src/types/workflow.js";
import { WORKFLOW_STARTED, WORKFLOW_COMPLETED, WORKFLOW_STEP_COMPLETED } from "../../src/types/workflow.js";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function createTestContext(): IPluginContext {
  const mockTool: ITool = {
    id: "test:echo",
    description: "Echo input",
    parameters: {} as any,
    async execute(input: any) {
      return `Echo: ${JSON.stringify(input)}`;
    },
  };

  const mockService = {
    name: "data-processor",
    version: "1.0.0",
    process: async (data: string) => ({ processed: data.toUpperCase() }),
  };

  const mockProvider: IProvider = {
    id: "test-llm",
    name: "Test LLM",
    models: [{ id: "test-model", name: "Test Model" }],
    async *chat({ messages }: any) {
      const userContent = messages[0].content[0].text;
      yield { type: "text_delta", text: `Response to: ${userContent}` };
    },
  };

  const events: any[] = [];

  return {
    bus: {
      emit: (event: any) => events.push(event),
      subscribe: () => () => {},
    },
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    tools: {
      list: () => [mockTool],
      get: (id: string) => (id === mockTool.id ? mockTool : undefined),
    },
    providers: {
      list: () => [mockProvider],
      get: (id: string) => (id === mockProvider.id ? mockProvider : undefined),
    },
    services: {
      register: () => {},
      get: (name: string) => (name === "data-processor" ? mockService : undefined),
      has: () => true,
      list: () => [mockService],
    },
    // @ts-ignore - add events for testing
    _events: events,
  };
}

describe("Workflow E2E", () => {
  it("should execute multi-step workflow with tool → service → llm", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "multi-step-test",
      version: "1.0.0",
      inputs: { text: { type: "string", required: true } },
      steps: [
        {
          name: "echo-input",
          type: "tool",
          tool: "test:echo",
          arguments: { message: "{{ inputs.text }}" },
        },
        {
          name: "process-data",
          type: "service",
          service: "data-processor",
          method: "process",
          arguments: ["{{ inputs.text }}"],
        },
        {
          name: "analyze",
          type: "llm",
          provider: "test-llm",
          prompt: "Analyze: {{ steps.process-data.processed }}",
        },
      ],
      outputs: {
        echo: "{{ steps.echo-input }}",
        analysis: "{{ steps.analyze }}",
      },
    };

    const result = await engine.execute(workflow, { text: "hello" });

    expect(result.status).toBe("completed");
    expect(result.outputs.echo).toContain("hello");
    expect(result.outputs.analysis).toContain("HELLO");
  });

  it("should chain step outputs correctly", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "chaining-test",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "step1",
          type: "service",
          service: "data-processor",
          method: "process",
          arguments: ["initial"],
        },
        {
          name: "step2",
          type: "llm",
          provider: "test-llm",
          prompt: "Previous: {{ steps.step1.processed }}",
        },
      ],
      outputs: { final: "{{ steps.step2 }}" },
    };

    const result = await engine.execute(workflow, {});

    expect(result.status).toBe("completed");
    expect(result.outputs.final).toContain("INITIAL");
  });

  it("should emit events in correct order", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "event-test",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "step1", type: "tool", tool: "test:echo", arguments: {} },
      ],
      outputs: {},
    };

    await engine.execute(workflow, {});

    const events = (ctx as any)._events;
    expect(events[0].type).toBe(WORKFLOW_STARTED);
    expect(events[events.length - 1].type).toBe(WORKFLOW_COMPLETED);

    const stepCompletedEvents = events.filter((e: any) => e.type === WORKFLOW_STEP_COMPLETED);
    expect(stepCompletedEvents).toHaveLength(1);
  });

  it("should stop execution and emit error events on step failure", async () => {
    const failingTool: ITool = {
      id: "fail:tool",
      description: "Fails",
      parameters: {} as any,
      async execute() {
        throw new Error("Intentional failure");
      },
    };

    const ctx = createTestContext();
    ctx.tools!.get = (id: string) => (id === "fail:tool" ? failingTool : undefined);

    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "error-test",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "failing-step", type: "tool", tool: "fail:tool", arguments: {} },
        { name: "never-reached", type: "tool", tool: "test:echo", arguments: {} },
      ],
      outputs: {},
    };

    await expect(engine.execute(workflow, {})).rejects.toThrow();

    const events = (ctx as any)._events;
    const errorEvents = events.filter((e: any) => e.type === "workflow:error");
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("should execute workflow with only tool steps", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "tool-only",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "tool1", type: "tool", tool: "test:echo", arguments: { a: 1 } },
        { name: "tool2", type: "tool", tool: "test:echo", arguments: { b: 2 } },
      ],
      outputs: { result: "{{ steps.tool2 }}" },
    };

    const result = await engine.execute(workflow, {});
    expect(result.status).toBe("completed");
  });

  it("should handle complex nested arguments", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);

    const workflow: IWorkflowDefinition = {
      name: "nested-args",
      version: "1.0.0",
      inputs: { path: { type: "string", required: true } },
      steps: [
        {
          name: "complex-step",
          type: "tool",
          tool: "test:echo",
          arguments: {
            nested: {
              path: "{{ inputs.path }}",
              array: ["item1", "{{ inputs.path }}"],
            },
          },
        },
      ],
      outputs: { result: "{{ steps.complex-step }}" },
    };

    const result = await engine.execute(workflow, { path: "/data/file.txt" });
    expect(result.status).toBe("completed");
    expect(result.outputs.result).toContain("/data/file.txt");
  });

  it("should load and execute workflow from YAML file", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);
    const service = createWorkflowService(engine);

    const yamlContent = `
name: "file-test"
version: "1.0.0"
inputs:
  message:
    type: string
    required: true
steps:
  - name: echo
    type: tool
    tool: "test:echo"
    arguments:
      text: "{{ inputs.message }}"
outputs:
  result: "{{ steps.echo }}"
`;

    const tmpFile = join(tmpdir(), `test-workflow-${Date.now()}.yaml`);
    await writeFile(tmpFile, yamlContent, "utf-8");

    try {
      const definition = await service.load(tmpFile);
      expect(definition.name).toBe("file-test");

      const result = await service.execute(tmpFile, { message: "hello" });
      expect(result.status).toBe("completed");
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("should execute workflow via service.execute with workflow name", async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine(ctx);
    const service = createWorkflowService(engine);

    const workflow: IWorkflowDefinition = {
      name: "named-workflow",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "tool", tool: "test:echo", arguments: {} }],
      outputs: {},
    };

    engine.loadWorkflow("/test/workflow.yaml", workflow);

    const result = await service.execute("named-workflow", {});
    expect(result.status).toBe("completed");
  });
});
