/**
 * Inference step schema validation tests.
 */

import { describe, it, expect } from "vitest";
import { WorkflowSchema } from "../../src/schema/workflow-schema.js";

function makeWorkflow(steps: unknown[]) {
  return {
    name: "test-inference",
    version: "1.0.0",
    inputs: {},
    steps,
    outputs: {},
  };
}

describe("InferenceStepSchema", () => {
  it("should validate a valid inference step with text input", () => {
    const workflow = makeWorkflow([
      {
        name: "classify",
        type: "inference",
        provider: "image-classifier",
        model: "mobilenet-v3",
        input: { type: "text", text: "a photo of a cat" },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should validate inference step with image input", () => {
    const workflow = makeWorkflow([
      {
        name: "detect",
        type: "inference",
        provider: "object-detector",
        input: {
          type: "image",
          data: "{{steps.read-file}}",
          mimeType: "image/png",
        },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should validate inference step with tensor input", () => {
    const workflow = makeWorkflow([
      {
        name: "extract-features",
        type: "inference",
        provider: "feature-extractor",
        input: {
          type: "tensor",
          shape: [1, 3, 224, 224],
          data: [0.5, 0.3, 0.1],
        },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should validate inference step with raw input", () => {
    const workflow = makeWorkflow([
      {
        name: "custom-infer",
        type: "inference",
        provider: "custom-model",
        input: { type: "raw", data: { key: "value" } },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should validate inference step with options", () => {
    const workflow = makeWorkflow([
      {
        name: "classify-with-options",
        type: "inference",
        provider: "image-classifier",
        input: { type: "text", text: "test" },
        options: { confidenceThreshold: 0.5, topK: 3 },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should reject inference step without provider", () => {
    const workflow = makeWorkflow([
      {
        name: "no-provider",
        type: "inference",
        input: { type: "text", text: "test" },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject inference step without input", () => {
    const workflow = makeWorkflow([
      {
        name: "no-input",
        type: "inference",
        provider: "test-provider",
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject inference step with invalid input type", () => {
    const workflow = makeWorkflow([
      {
        name: "bad-input",
        type: "inference",
        provider: "test-provider",
        input: { type: "invalid", data: "test" },
      },
    ]);

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should coexist with other step types in same workflow", () => {
    const workflow = {
      name: "mixed-pipeline",
      version: "1.0.0",
      inputs: {
        imagePath: { type: "string", required: true },
      },
      steps: [
        {
          name: "read-image",
          type: "tool",
          tool: "fs:read-binary",
          arguments: { path: "{{inputs.imagePath}}" },
        },
        {
          name: "classify",
          type: "inference",
          provider: "image-classifier",
          model: "mobilenet-v3",
          input: { type: "image", data: "{{steps.read-image}}", mimeType: "image/png" },
        },
        {
          name: "describe",
          type: "llm",
          provider: "claude",
          prompt: "Describe the classification: {{steps.classify}}",
        },
      ],
      outputs: {
        classification: "{{steps.classify}}",
        description: "{{steps.describe}}",
      },
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });
});
