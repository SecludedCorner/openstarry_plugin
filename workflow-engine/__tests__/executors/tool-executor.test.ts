/**
 * Tool step executor tests.
 */

import { describe, it, expect } from "vitest";
import type { IPluginContext, ITool } from "@openstarry/sdk";
import { executeToolStep } from "../../src/engine/executors/tool-executor.js";
import type { IToolStep } from "../../src/types/workflow.js";
import { WorkflowExecutionError } from "../../src/errors.js";

function createMockContext(tool?: ITool): IPluginContext {
  return {
    bus: { emit: () => {}, subscribe: () => () => {} },
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    tools: {
      list: () => (tool ? [tool] : []),
      get: (id: string) => (tool && tool.id === id ? tool : undefined),
    },
  };
}

describe("executeToolStep", () => {
  it("should execute tool and return result", async () => {
    const mockTool: ITool = {
      id: "fs:read",
      description: "Read file",
      parameters: {} as any,
      async execute(input: any) {
        return `File content from ${input.path}`;
      },
    };

    const step: IToolStep = {
      name: "read-file",
      type: "tool",
      tool: "fs:read",
      arguments: { path: "/data/test.txt" },
    };

    const ctx = createMockContext(mockTool);
    const result = await executeToolStep(step, {}, ctx, "exec-123");

    expect(result).toBe("File content from /data/test.txt");
  });

  it("should throw error if tool not found", async () => {
    const step: IToolStep = {
      name: "missing-tool",
      type: "tool",
      tool: "non-existent",
      arguments: {},
    };

    const ctx = createMockContext();

    await expect(
      executeToolStep(step, {}, ctx, "exec-123")
    ).rejects.toThrow(WorkflowExecutionError);
  });

  it("should propagate tool execution errors", async () => {
    const mockTool: ITool = {
      id: "failing-tool",
      description: "Fails",
      parameters: {} as any,
      async execute() {
        throw new Error("Tool failed");
      },
    };

    const step: IToolStep = {
      name: "fail-step",
      type: "tool",
      tool: "failing-tool",
      arguments: {},
    };

    const ctx = createMockContext(mockTool);

    await expect(
      executeToolStep(step, {}, ctx, "exec-123")
    ).rejects.toThrow(WorkflowExecutionError);
  });
});
