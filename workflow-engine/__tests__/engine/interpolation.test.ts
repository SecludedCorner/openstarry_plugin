/**
 * Variable interpolation tests.
 */

import { describe, it, expect } from "vitest";
import { interpolate } from "../../src/engine/interpolate.js";
import { VariableInterpolationError } from "../../src/errors.js";

describe("interpolate", () => {
  it("should interpolate input variables", () => {
    const context = {
      inputs: { name: "Alice", age: 30 },
      steps: {},
    };

    const result = interpolate("Hello, {{ inputs.name }}!", context);
    expect(result).toBe("Hello, Alice!");
  });

  it("should interpolate step outputs", () => {
    const context = {
      inputs: {},
      steps: { "load-data": "file contents" },
    };

    const result = interpolate("Data: {{ steps.load-data }}", context);
    expect(result).toBe("Data: file contents");
  });

  it("should interpolate nested object paths", () => {
    const context = {
      inputs: {},
      steps: {
        parse: {
          rows: [{ name: "Alice" }, { name: "Bob" }],
          count: 2,
        },
      },
    };

    const result = interpolate("First: {{ steps.parse.rows.0.name }}", context);
    expect(result).toBe("First: Alice");
  });

  it("should return string as-is if no template markers", () => {
    const context = { inputs: {}, steps: {} };
    const result = interpolate("plain text", context);
    expect(result).toBe("plain text");
  });

  it("should return string as-is if template has no variables", () => {
    const context = { inputs: {}, steps: {} };
    const result = interpolate("text with {{ }} markers", context);
    expect(result).toBe("text with  markers"); // Mustache renders empty
  });

  it("should recursively interpolate nested structures", () => {
    const context = {
      inputs: { path: "/data/file.txt" },
      steps: { result: "success" },
    };

    const input = {
      file: "{{ inputs.path }}",
      status: "{{ steps.result }}",
      nested: {
        deep: "{{ inputs.path }}",
      },
      array: ["{{ steps.result }}", "static"],
    };

    const result = interpolate(input, context);
    expect(result).toEqual({
      file: "/data/file.txt",
      status: "success",
      nested: {
        deep: "/data/file.txt",
      },
      array: ["success", "static"],
    });
  });
});
