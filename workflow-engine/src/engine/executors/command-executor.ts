/**
 * Command step executor (not supported in MVP).
 */

import type { ICommandStep } from "../../types/workflow.js";
import { CommandStepNotSupportedError } from "../../errors.js";

/**
 * Execute a command step.
 * NOT SUPPORTED in MVP — throws error.
 *
 * @param step - Command step definition
 * @throws CommandStepNotSupportedError
 */
export async function executeCommandStep(
  step: ICommandStep
): Promise<never> {
  throw new CommandStepNotSupportedError(step.name);
}
