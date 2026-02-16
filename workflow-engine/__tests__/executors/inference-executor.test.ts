/**
 * Inference step executor tests.
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, IProvider, InferenceResult } from "@openstarry/sdk";
import type { IInferenceProvider } from "@openstarry/sdk";
import { executeInferenceStep } from "../../src/engine/executors/inference-executor.js";
import type { IInferenceStep } from "../../src/types/workflow.js";
import { WorkflowExecutionError } from "../../src/errors.js";

function createMockInferenceProvider(): IInferenceProvider {
  return {
    id: "test-cnn",
    name: "Test CNN",
    models: [{ id: "mobilenet-v3", name: "MobileNet V3" }],
    chat: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "adapter output" };
    }),
    infer: vi.fn(async (request) => ({
      model: request.model,
      output: {
        type: "classification" as const,
        labels: [
          { label: "cat", score: 0.95 },
          { label: "dog", score: 0.03 },
        ],
      },
    })),
  };
}

function createMockLLMProvider(): IProvider {
  return {
    id: "llm-only",
    name: "LLM Only",
    models: [{ id: "gpt-4", name: "GPT-4" }],
    chat: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "llm response" };
    }),
  };
}

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

describe("executeInferenceStep", () => {
  it("should execute inference provider and return InferenceResult", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "classify",
      type: "inference",
      provider: "test-cnn",
      model: "mobilenet-v3",
      input: { type: "text", text: "a photo of a cat" },
    };

    const ctx = createMockContext(provider);
    const result = await executeInferenceStep(step, {}, ctx, "exec-1");

    expect(provider.infer).toHaveBeenCalled();
    const inferResult = result as InferenceResult;
    expect(inferResult.model).toBe("mobilenet-v3");
    expect(inferResult.output.type).toBe("classification");
    if (inferResult.output.type === "classification") {
      expect(inferResult.output.labels[0].label).toBe("cat");
      expect(inferResult.output.labels[0].score).toBe(0.95);
    }
  });

  it("should throw if provider not found", async () => {
    const step: IInferenceStep = {
      name: "missing",
      type: "inference",
      provider: "nonexistent",
      input: { type: "text", text: "test" },
    };

    const ctx = createMockContext(undefined);

    await expect(
      executeInferenceStep(step, {}, ctx, "exec-2")
    ).rejects.toThrow(WorkflowExecutionError);
  });

  it("should throw if provider does not support inference", async () => {
    const llmProvider = createMockLLMProvider();
    const step: IInferenceStep = {
      name: "wrong-type",
      type: "inference",
      provider: "llm-only",
      input: { type: "text", text: "test" },
    };

    const ctx = createMockContext(llmProvider);

    await expect(
      executeInferenceStep(step, {}, ctx, "exec-3")
    ).rejects.toThrow("does not support inference");
  });

  it("should use first model if model not specified in step", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "auto-model",
      type: "inference",
      provider: "test-cnn",
      input: { type: "text", text: "test" },
    };

    const ctx = createMockContext(provider);
    await executeInferenceStep(step, {}, ctx, "exec-4");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({ model: "mobilenet-v3" })
    );
  });

  it("should interpolate Mustache templates in input", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "interpolated",
      type: "inference",
      provider: "test-cnn",
      input: { type: "text", text: "{{inputs.query}}" },
    };

    const context = { inputs: { query: "hello world" } };
    const ctx = createMockContext(provider);
    await executeInferenceStep(step, context, ctx, "exec-5");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { type: "text", text: "hello world" },
      })
    );
  });

  it("should propagate inference provider errors", async () => {
    const provider = createMockInferenceProvider();
    (provider.infer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Model loading failed")
    );

    const step: IInferenceStep = {
      name: "fail",
      type: "inference",
      provider: "test-cnn",
      input: { type: "text", text: "test" },
    };

    const ctx = createMockContext(provider);

    await expect(
      executeInferenceStep(step, {}, ctx, "exec-6")
    ).rejects.toThrow("Inference provider failed");
  });

  it("should handle image input type", async () => {
    const provider = createMockInferenceProvider();
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const step: IInferenceStep = {
      name: "image-classify",
      type: "inference",
      provider: "test-cnn",
      input: {
        type: "image",
        data: imageData as any,
        mimeType: "image/png",
      },
    };

    const ctx = createMockContext(provider);
    await executeInferenceStep(step, {}, ctx, "exec-7");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ type: "image", mimeType: "image/png" }),
      })
    );
  });

  it("should handle tensor input type", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "tensor-infer",
      type: "inference",
      provider: "test-cnn",
      input: {
        type: "tensor",
        shape: [1, 3, 224, 224] as any,
        data: [0.5, 0.3, 0.1] as any,
      },
    };

    const ctx = createMockContext(provider);
    await executeInferenceStep(step, {}, ctx, "exec-8");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          type: "tensor",
          shape: [1, 3, 224, 224],
        }),
      })
    );
  });

  it("should pass options to inference request", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "with-options",
      type: "inference",
      provider: "test-cnn",
      input: { type: "text", text: "test" },
      options: { confidenceThreshold: 0.5, topK: 3 },
    };

    const ctx = createMockContext(provider);
    await executeInferenceStep(step, {}, ctx, "exec-9");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { confidenceThreshold: 0.5, topK: 3 },
      })
    );
  });

  it("should handle raw input type for unknown formats", async () => {
    const provider = createMockInferenceProvider();
    const step: IInferenceStep = {
      name: "raw-input",
      type: "inference",
      provider: "test-cnn",
      input: { type: "raw", data: { custom: "payload" } as any },
    };

    const ctx = createMockContext(provider);
    await executeInferenceStep(step, {}, ctx, "exec-10");

    expect(provider.infer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { type: "raw", data: { custom: "payload" } },
      })
    );
  });
});
