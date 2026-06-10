/**
 * Command step executor tests.
 */

import { describe, it, expect } from "vitest";
import { executeCommandStep } from "../../src/engine/executors/command-executor.js";
import type { ICommandStep } from "../../src/types/workflow.js";
import { CommandStepNotSupportedError } from "../../src/errors.js";

describe("executeCommandStep", () => {
  it("should throw CommandStepNotSupportedError", async () => {
    const step: ICommandStep = {
      name: "run-command",
      type: "command",
      command: "echo",
      args: "hello",
    };

    await expect(executeCommandStep(step)).rejects.toThrow(
      CommandStepNotSupportedError
    );

    try {
      await executeCommandStep(step);
    } catch (error) {
      expect(error).toBeInstanceOf(CommandStepNotSupportedError);
      expect((error as CommandStepNotSupportedError).stepName).toBe("run-command");
      expect((error as Error).message).toContain("not supported in MVP");
      expect((error as Error).message).toContain("v0.18.1");
    }
  });
});
