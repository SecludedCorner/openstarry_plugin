/**
 * StandardConfirmationGate config types.
 * @skandha samskara (行蘊)
 */

import type { RiskCategory } from "@openstarry/sdk";

export interface StandardGateConfig {
  readonly userPromptTimeoutMs?: number;
  readonly bypassCategories?: readonly RiskCategory[];
  readonly bypassGears?: readonly number[];
  readonly alwaysConfirmTools?: readonly string[];
  readonly neverConfirmTools?: readonly string[];
}
