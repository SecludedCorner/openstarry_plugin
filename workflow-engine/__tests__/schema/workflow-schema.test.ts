/**
 * Schema validation tests.
 */

import { describe, it, expect } from "vitest";
import { WorkflowSchema } from "../../src/schema/workflow-schema.js";

describe("WorkflowSchema", () => {
  it("should validate a complete workflow with all step types", () => {
    const workflow = {
      name: "test-workflow",
      version: "1.0.0",
      description: "Test workflow",
      inputs: {
        dataPath: { type: "string", required: true },
        threshold: { type: "number", required: false, default: 10 },
      },
      steps: [
        {
          name: "load-data",
          type: "tool",
          tool: "fs:read",
          arguments: { path: "{{ inputs.dataPath }}" },
        },
        {
          name: "parse-data",
          type: "service",
          service: "skill-parser",
          method: "parse",
          arguments: ["{{ steps.load-data }}", "csv"],
        },
        {
          name: "analyze",
          type: "llm",
          provider: "anthropic",
          prompt: "Analyze: {{ steps.parse-data }}",
          model: "claude-opus-4-6",
          temperature: 0.5,
        },
        {
          name: "notify",
          type: "command",
          command: "echo",
          args: "Done",
        },
      ],
      outputs: {
        result: "{{ steps.analyze }}",
      },
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("should reject workflow with missing required fields", () => {
    const workflow = {
      // Missing 'name'
      version: "1.0.0",
      inputs: {},
      steps: [],
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject workflow with invalid semver version", () => {
    const workflow = {
      name: "test",
      version: "v1.0", // Invalid semver
      inputs: {},
      steps: [{ name: "step1", type: "tool", tool: "test", arguments: {} }],
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("semver");
    }
  });

  it("should reject workflow with empty steps array", () => {
    const workflow = {
      name: "test",
      version: "1.0.0",
      inputs: {},
      steps: [], // Empty
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("at least one step");
    }
  });

  it("should reject step with invalid type", () => {
    const workflow = {
      name: "test",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "invalid", foo: "bar" }],
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject tool step with missing required fields", () => {
    const workflow = {
      name: "test",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "step1", type: "tool" }], // Missing 'tool' and 'arguments'
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject input with invalid type", () => {
    const workflow = {
      name: "test",
      version: "1.0.0",
      inputs: {
        param1: { type: "invalid-type", required: true }, // Invalid type
      },
      steps: [{ name: "step1", type: "tool", tool: "test", arguments: {} }],
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("should reject step with invalid name format", () => {
    const workflow = {
      name: "test",
      version: "1.0.0",
      inputs: {},
      steps: [
        {
          name: "invalid step name!", // Contains special characters
          type: "tool",
          tool: "test",
          arguments: {},
        },
      ],
      outputs: {},
    };

    const result = WorkflowSchema.safeParse(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("alphanumeric");
    }
  });
});
