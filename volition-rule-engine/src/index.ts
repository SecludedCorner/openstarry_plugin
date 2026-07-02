/**
 * @openstarry-plugin/volition-rule-engine
 *
 * IVolition v1 plugin with three-layer rule engine for risk-aware deliberation.
 *
 * @skandha vijnana (識蘊)
 * @see Plan28: IVolition v1 + Safety Hardening
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import {
  createRuleEngineVolition,
  DEFAULT_VOLITION_RULE_ENGINE_CONFIG,
  type VolitionRuleEngineConfig,
} from "./rule-engine.js";

export { createRuleEngineVolition, DEFAULT_VOLITION_RULE_ENGINE_CONFIG };
export type {
  VolitionRuleEngineConfig,
  VolitionMode,
  HardRule,
  SoftRule,
  HeuristicRule,
  VolitionRuleEngineHooks,
  VolitionVetoNotice,
} from "./rule-engine.js";

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
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // agent.json plugin config wins over factory config (same pattern as
      // gear-arbiter-static / standard-function-exec) — before V-1 this
      // factory ignored ctx.config entirely, so hardRules were untunable
      // from a config file (C#1 feel-test finding).
      const ctxConfig = ctx.config as Partial<VolitionRuleEngineConfig> | undefined;
      const effectiveConfig: VolitionRuleEngineConfig = { ...config, ...(ctxConfig ?? {}) };

      // V-1 (veto observability): the loop applies a plan-level veto as a
      // silent filter — no tool_result, no user message. Surface every veto
      // through the EXISTING TOOL_BLOCKED event (no new SDK surface) so the
      // UI can render it. Never a silent disappearance again.
      const volition = createRuleEngineVolition(effectiveConfig, {
        onVeto: ({ toolName, reasoning, phase }) => {
          ctx.bus.emit({
            type: AgentEventType.TOOL_BLOCKED,
            timestamp: Date.now(),
            payload: {
              toolCallId: toolName,
              name: toolName,
              reason: `volition veto (${phase}): ${reasoning}`,
            },
          });
        },
      });
      return { volition };
    },
  };
}

export default createVolitionRuleEnginePlugin;
