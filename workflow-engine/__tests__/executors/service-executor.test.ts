/**
 * Service step executor tests.
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext } from "@openstarry/sdk";
import { executeServiceStep } from "../../src/engine/executors/service-executor.js";
import type { IServiceStep } from "../../src/types/workflow.js";
import { WorkflowExecutionError } from "../../src/errors.js";

function createMockContext(service?: any): IPluginContext {
  return {
    bus: { emit: () => {}, subscribe: () => () => {} },
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    services: {
      register: () => {},
      get: (name: string) => service,
      has: () => !!service,
      list: () => (service ? [service] : []),
    },
  };
}

describe("executeServiceStep", () => {
  it("should execute service method and return result", async () => {
    const mockService = {
      name: "skill-parser",
      version: "1.0.0",
      parse: vi.fn(async (data: string, format: string) => ({
        format,
        rows: ["row1", "row2"],
      })),
    };

    const step: IServiceStep = {
      name: "parse-data",
      type: "service",
      service: "skill-parser",
      method: "parse",
      arguments: ["csv data", "csv"],
    };

    const ctx = createMockContext(mockService);
    const result = await executeServiceStep(step, {}, ctx, "exec-123");

    expect(mockService.parse).toHaveBeenCalledWith("csv data", "csv");
    expect(result).toEqual({ format: "csv", rows: ["row1", "row2"] });
  });

  it("should return undefined if service not found (soft warning)", async () => {
    const step: IServiceStep = {
      name: "missing-service",
      type: "service",
      service: "non-existent",
      method: "doSomething",
      arguments: [],
    };

    const ctx = createMockContext(undefined);

    // Should log warning but not throw
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await executeServiceStep(step, {}, ctx, "exec-123");

    expect(consoleSpy).toHaveBeenCalled();
    expect(result).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("should throw error if service method throws", async () => {
    const mockService = {
      name: "failing-service",
      version: "1.0.0",
      doWork: vi.fn(async () => {
        throw new Error("Service error");
      }),
    };

    const step: IServiceStep = {
      name: "fail-step",
      type: "service",
      service: "failing-service",
      method: "doWork",
      arguments: [],
    };

    const ctx = createMockContext(mockService);

    await expect(
      executeServiceStep(step, {}, ctx, "exec-123")
    ).rejects.toThrow(WorkflowExecutionError);
  });
});
