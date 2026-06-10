/**
 * @openstarry-plugin/confirmation-gate-standard
 *
 * Standard confirmation gate (samskara — action gating).
 * Rule-based pre-execution confirmation with configurable bypass rules.
 *
 * 二諦聲明 (Two Truths Declaration):
 * - 世俗諦: This plugin provides a rule-based gate that intercepts tool execution
 *   for human-in-the-loop confirmation.
 * - 勝義諦: The gate embodies cetana (intention) → action gating. Just as mindful
 *   awareness (sati) precedes volitional action (cetana) in the Buddhist model,
 *   this gate provides a moment of pause between intention and execution.
 *
 * @skandha samskara (行蘊)
 * @criticality optional-no-effect
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createStandardConfirmationGate } from "./standard-gate.js";
import type { StandardGateConfig } from "./types.js";

export function createConfirmationGateStandardPlugin(): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/confirmation-gate-standard',
      version: '0.1.0-alpha',
      description: 'Standard confirmation gate (samskara — action gating)',
      skandha: 'samskara',
      criticality: 'optional-no-effect',
      dependencies: [],
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Partial<StandardGateConfig> ?? {};
      const gate = createStandardConfirmationGate(config);

      return {
        confirmationGate: gate,
      };
    },
  };
}

export { createStandardConfirmationGate } from "./standard-gate.js";
export type { StandardGateConfig } from "./types.js";
export default createConfirmationGateStandardPlugin;
