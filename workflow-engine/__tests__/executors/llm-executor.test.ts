/**
 * LLM step executor tests.
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, IProvider } from "@openstarry/sdk";
import { executeLLMStep } from "../../src/engine/executors/llm-executor.js";
import type { ILLMStep } from "../../src/types/workflow.js";
import { WorkflowExecutionError } from "../../src/errors.js";

function createMockContext(provider?: IProvider): IPluginContext {
  return {
    bus: { emit: () => {}, subscribe: () => () => {} },
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    providers: {
      list: () => (provider ? [provider] : []),
      get: (id: string) => (provider && provider.id === id ? provider : undefined),
    },
  };
}

describe("executeLLMStep", () => {
  it("should execute LLM provider and return response", async () => {
    const mockProvider: IProvider = {
      id: "anthropic",
      name: "Anthropic",
      models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
      chat: vi.fn(async function* () {
        yield { type: "text_delta", text: "Analysis " };
        yield { type: "text_delta", text: "complete" };
      }),
    };

    const step: ILLMStep = {
      name: "analyze",
      type: "llm",
      provider: "anthropic",
      prompt: "Analyze this data",
      model: "claude-opus-4-6",
      temperature: 0.5,
    };

    const ctx = createMockContext(mockProvider);
    const result = await executeLLMStep(step, {}, ctx, "exec-123");

    expect(mockProvider.chat).toHaveBeenCalled();
    expect(result).toBe("Analysis complete");
  });

  it("should throw error if provider not found", async () => {
    const step: ILLMStep = {
      name: "missing-provider",
      type: "llm",
      provider: "non-existent",
      prompt: "Test",
    };

    const ctx = createMockContext(undefined);

    await expect(
      executeLLMStep(step, {}, ctx, "exec-123")
    ).rejects.toThrow(WorkflowExecutionError);
  });

  it("should propagate provider errors", async () => {
    const mockProvider: IProvider = {
      id: "failing-provider",
      name: "Failing",
      models: [],
      chat: vi.fn(async function* () {
        throw new Error("Provider error");
      }),
    };

    const step: ILLMStep = {
      name: "fail-step",
      type: "llm",
      provider: "failing-provider",
      prompt: "Test",
    };

    const ctx = createMockContext(mockProvider);

    await expect(
      executeLLMStep(step, {}, ctx, "exec-123")
    ).rejects.toThrow(WorkflowExecutionError);
  });
});
