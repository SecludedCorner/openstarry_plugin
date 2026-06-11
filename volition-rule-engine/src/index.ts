/**
 * @openstarry-plugin/volition-rule-engine
 *
 * IVolition v1 plugin with three-layer rule engine for risk-aware deliberation.
 *
 * @skandha vijnana (識蘊)
 * @see Plan28: IVolition v1 + Safety Hardening
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import {
  createRuleEngineVolition,
  DEFAULT_VOLITION_RULE_ENGINE_CONFIG,
  type VolitionRuleEngineConfig,
} from "./rule-engine.js";

export { createRuleEngineVolition, DEFAULT_VOLITION_RULE_ENGINE_CONFIG };
export type { VolitionRuleEngineConfig, HardRule, SoftRule, HeuristicRule } from "./rule-engine.js";

export function createVolitionRuleEnginePlugin(
  config: VolitionRuleEngineConfig = DEFAULT_VOLITION_RULE_ENGINE_CONFIG,
): IPlugin {
  return {
    manifest: {
      name: 'volition-rule-engine',
      version: '0.1.0-alpha',
      description: 'IVolition v1 three-layer rule engine for risk-aware deliberation',
      skandha: 'vijnana',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const volition = createRuleEngineVolition(config);
      return { volition };
    },
  };
}

export default createVolitionRuleEnginePlugin;
