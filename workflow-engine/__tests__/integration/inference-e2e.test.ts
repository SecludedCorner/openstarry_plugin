/**
 * Inference step end-to-end integration tests.
 *
 * Tests the full chain: WorkflowEngine → executeStep → inference-executor → IInferenceProvider
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, IProvider } from "@openstarry/sdk";
import type { IInferenceProvider, InferenceRequest, InferenceResult } from "@openstarry/sdk";
import { isInferenceProvider } from "@openstarry/sdk";
import { WorkflowEngine } from "../../src/engine/workflow-engine.js";
import type { IWorkflowDefinition } from "../../src/types/workflow.js";

function createInferenceProvider(): IInferenceProvider {
  const provider: IInferenceProvider = {
    id: "test-cnn",
    name: "Test CNN",
    models: [{ id: "mobilenet-v3", name: "MobileNet V3" }],
    // chat() adapter: converts last user message → infer() → yields JSON text
    async *chat(request) {
      const lastMsg = request.messages[request.messages.length - 1];
      const text = lastMsg?.content
        .filter((s): s is { type: "text"; text: string } => s.type === "text")
        .map((s) => s.text)
        .join(" ") || "";

      const result = await provider.infer({
        model: request.model,
        input: { type: "text", text },
        signal: request.signal,
      });

      yield { type: "text_delta" as const, text: JSON.stringify(result.output) };
      yield { type: "finish" as const, stopReason: "end_turn" as const };
    },
    async infer(request: InferenceRequest): Promise<InferenceResult> {
      return {
        model: request.model,
        output: {
          type: "classification",
          labels: [
            { label: "cat", score: 0.95 },
            { label: "dog", score: 0.03 },
          ],
        },
        metadata: { latencyMs: 42 },
      };
    },
  };
  return provider;
}

function createLLMProvider(): IProvider {
  return {
    id: "test-llm",
    name: "Test LLM",
    models: [{ id: "gpt-4", name: "GPT-4" }],
    async *chat() {
      yield { type: "text_delta" as const, text: "LLM response text" };
      yield { type: "finish" as const, stopReason: "end_turn" as const };
    },
  };
}

function createMockContext(providers: IProvider[]): IPluginContext {
  return {
    bus: { emit: vi.fn(), on: vi.fn(() => () => {}), once: vi.fn(() => () => {}), onAny: vi.fn(() => () => {}) },
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
    pushInput: vi.fn(),
    sessions: {} as any,
    providers: {
      list: () => providers,
      get: (id: string) => providers.find((p) => p.id === id),
    },
    tools: {
      list: () => [],
      get: () => undefined,
    },
    services: {
      register: () => {},
      get: () => undefined,
      has: () => false,
      list: () => [],
    },
  };
}

describe("isInferenceProvider type guard", () => {
  it("returns true for IInferenceProvider", () => {
    const provider = createInferenceProvider();
    expect(isInferenceProvider(provider)).toBe(true);
  });

  it("returns false for plain IProvider", () => {
    const provider = createLLMProvider();
    expect(isInferenceProvider(provider)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isInferenceProvider(undefined)).toBe(false);
  });
});

describe("WorkflowEngine inference step integration", () => {
  it("should execute an inference step in a workflow", async () => {
    const inferenceProvider = createInferenceProvider();
    const ctx = createMockContext([inferenceProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "inference-test",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "classify",
          type: "inference",
          provider: "test-cnn",
          model: "mobilenet-v3",
          input: { type: "text", text: "a cat photo" },
        },
      ],
      outputs: {
        model: "{{steps.classify.model}}",
        outputType: "{{steps.classify.output.type}}",
      },
    };

    const result = await engine.execute(definition, {});

    expect(result.status).toBe("completed");
    expect(result.outputs.model).toBe("mobilenet-v3");
    expect(result.outputs.outputType).toBe("classification");
  });

  it("should chain inference step with LLM step", async () => {
    const inferenceProvider = createInferenceProvider();
    const llmProvider = createLLMProvider();
    const ctx = createMockContext([inferenceProvider, llmProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "inference-llm-chain",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "classify",
          type: "inference",
          provider: "test-cnn",
          input: { type: "text", text: "image data" },
        },
        {
          name: "describe",
          type: "llm",
          provider: "test-llm",
          prompt: "Describe: {{steps.classify}}",
        },
      ],
      outputs: {
        classOutputType: "{{steps.classify.output.type}}",
        description: "{{steps.describe}}",
      },
    };

    const result = await engine.execute(definition, {});

    expect(result.status).toBe("completed");
    expect(result.outputs.classOutputType).toBe("classification");
    expect(result.outputs.description).toBe("LLM response text");
  });

  it("should fail when inference step targets a non-inference provider", async () => {
    const llmProvider = createLLMProvider();
    const ctx = createMockContext([llmProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "wrong-provider-type",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "classify",
          type: "inference",
          provider: "test-llm",
          input: { type: "text", text: "test" },
        },
      ],
      outputs: {},
    };

    await expect(engine.execute(definition, {})).rejects.toThrow(
      "does not support inference"
    );
  });

  it("should support multiple inference steps in pipeline", async () => {
    const cnnProvider: IInferenceProvider = {
      id: "cnn",
      name: "CNN",
      models: [{ id: "resnet-50", name: "ResNet-50" }],
      async *chat() {
        yield { type: "text_delta" as const, text: "adapter" };
      },
      async infer(req: InferenceRequest): Promise<InferenceResult> {
        return {
          model: req.model,
          output: { type: "classification", labels: [{ label: "cat", score: 0.9 }] },
        };
      },
    };

    const dnnProvider: IInferenceProvider = {
      id: "dnn",
      name: "DNN Feature Extractor",
      models: [{ id: "vgg-16", name: "VGG-16" }],
      async *chat() {
        yield { type: "text_delta" as const, text: "adapter" };
      },
      async infer(req: InferenceRequest): Promise<InferenceResult> {
        return {
          model: req.model,
          output: { type: "features", vector: [0.1, 0.2, 0.3, 0.4] },
        };
      },
    };

    const ctx = createMockContext([cnnProvider, dnnProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "multi-inference-pipeline",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "classify",
          type: "inference",
          provider: "cnn",
          model: "resnet-50",
          input: { type: "text", text: "image data" },
        },
        {
          name: "extract-features",
          type: "inference",
          provider: "dnn",
          model: "vgg-16",
          input: { type: "text", text: "image data" },
        },
      ],
      outputs: {
        classOutputType: "{{steps.classify.output.type}}",
        featureOutputType: "{{steps.extract-features.output.type}}",
        classModel: "{{steps.classify.model}}",
        featureModel: "{{steps.extract-features.model}}",
      },
    };

    const result = await engine.execute(definition, {});
    expect(result.status).toBe("completed");

    expect(result.outputs.classOutputType).toBe("classification");
    expect(result.outputs.featureOutputType).toBe("features");
    expect(result.outputs.classModel).toBe("resnet-50");
    expect(result.outputs.featureModel).toBe("vgg-16");
  });

  it("LLM step calling IInferenceProvider uses chat() adapter", async () => {
    // An inference provider registered normally — LLM step should call chat()
    // which internally delegates to infer() and yields JSON text.
    const inferenceProvider = createInferenceProvider();
    const ctx = createMockContext([inferenceProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "llm-calls-inference-adapter",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          // Use "llm" step type to call an inference provider via chat() adapter
          name: "classify-via-llm",
          type: "llm",
          provider: "test-cnn",
          model: "mobilenet-v3",
          prompt: "classify this image",
        },
      ],
      outputs: {
        result: "{{steps.classify-via-llm}}",
      },
    };

    const result = await engine.execute(definition, {});

    expect(result.status).toBe("completed");
    // chat() adapter yields JSON.stringify(result.output)
    const outputText = result.outputs.result as string;
    const parsed = JSON.parse(outputText);
    expect(parsed.type).toBe("classification");
    expect(parsed.labels).toHaveLength(2);
    expect(parsed.labels[0].label).toBe("cat");
    expect(parsed.labels[0].score).toBe(0.95);
  });

  it("inference output nested fields accessible via Mustache in subsequent steps", async () => {
    // Verify that InferenceResult object properties can be accessed
    // by Mustache in subsequent LLM step prompts.
    const inferenceProvider = createInferenceProvider();
    let capturedPrompt = "";
    const llmProvider: IProvider = {
      id: "test-llm",
      name: "Test LLM",
      models: [{ id: "gpt-4", name: "GPT-4" }],
      async *chat(request) {
        // Capture the prompt that was sent to verify Mustache resolved correctly
        const userMsg = request.messages[0];
        capturedPrompt = userMsg.content
          .filter((s): s is { type: "text"; text: string } => s.type === "text")
          .map((s) => s.text)
          .join("");
        yield { type: "text_delta" as const, text: "LLM saw the data" };
        yield { type: "finish" as const, stopReason: "end_turn" as const };
      },
    };

    const ctx = createMockContext([inferenceProvider, llmProvider]);
    const engine = new WorkflowEngine(ctx);

    const definition: IWorkflowDefinition = {
      name: "mustache-nested-access",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "classify",
          type: "inference",
          provider: "test-cnn",
          input: { type: "text", text: "test image" },
        },
        {
          name: "summarize",
          type: "llm",
          provider: "test-llm",
          prompt: "Model: {{steps.classify.model}}, Type: {{steps.classify.output.type}}, Latency: {{steps.classify.metadata.latencyMs}}ms",
        },
      ],
      outputs: {
        summary: "{{steps.summarize}}",
      },
    };

    const result = await engine.execute(definition, {});

    expect(result.status).toBe("completed");
    // Verify the LLM received correctly interpolated prompt
    expect(capturedPrompt).toBe("Model: mobilenet-v3, Type: classification, Latency: 42ms");
    expect(result.outputs.summary).toBe("LLM saw the data");
  });
});
