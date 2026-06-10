/**
 * gear-arbiter-static — StaticRuleArbiter plugin.
 *
 * Provides deterministic, rule-based gear routing via pattern matching.
 * evaluate() = pure pattern matching, no state, no learning.
 * Registered via PluginHooks.gearArbiters.
 *
 * Buddhist mapping: 教誡 (śīla) — explicit taught rules.
 *
 * @skandha samjna, vijnana
 * @see Plan27b: P27-V StaticRuleArbiter
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IGearArbiter,
  GearContext,
  GearEvaluation,
  RiskCategory,
} from "@openstarry/sdk";
import { safeRegexTest } from "@openstarry/shared";

const RISK_ORDER: Record<string, number> = {
  destructive: 3, state_modifying: 2, read_only: 1, informational: 0,
};

export interface StaticRule {
  readonly pattern: string | RegExp;
  readonly gear: number;
  readonly confidence: number;
  readonly riskCategory?: RiskCategory;
}

export interface StaticRuleArbiterConfig {
  readonly rules: readonly StaticRule[];
}

export const DEFAULT_STATIC_RULES: StaticRule[] = [
  { pattern: 'fs.read',     gear: 1, confidence: 0.90, riskCategory: 'read_only' },
  { pattern: 'fs.list',     gear: 1, confidence: 0.95, riskCategory: 'informational' },
  { pattern: 'fs.write',    gear: 1, confidence: 0.70, riskCategory: 'state_modifying' },
  { pattern: 'fs.mkdir',    gear: 1, confidence: 0.80, riskCategory: 'state_modifying' },
  { pattern: 'fs.delete',   gear: 1, confidence: 0.50, riskCategory: 'destructive' },
  // Legacy tool name aliases
  { pattern: 'read_file',   gear: 1, confidence: 0.90, riskCategory: 'read_only' },
  { pattern: 'list_files',  gear: 1, confidence: 0.95, riskCategory: 'informational' },
  { pattern: 'search_code', gear: 1, confidence: 0.85, riskCategory: 'read_only' },
  { pattern: 'write_file',  gear: 1, confidence: 0.70, riskCategory: 'state_modifying' },
];

function createStaticRuleEvaluator(config: StaticRuleArbiterConfig) {
  return function evaluate(context: GearContext): GearEvaluation {
    let worstRisk: { rule: StaticRule; riskLevel: number } | null = null;
    for (const rule of config.rules) {
      const matched = context.proposedToolCalls.some(tc =>
        typeof rule.pattern === 'string'
          ? tc.name === rule.pattern
          : safeRegexTest(rule.pattern, tc.name)
      );
      if (matched) {
        const riskLevel = RISK_ORDER[rule.riskCategory ?? 'informational'] ?? 0;
        if (!worstRisk || riskLevel > worstRisk.riskLevel) {
          worstRisk = { rule, riskLevel };
        }
      }
    }
    return worstRisk
      ? {
          action: worstRisk.rule.gear,
          confidence: worstRisk.rule.confidence,
          riskCategory: worstRisk.rule.riskCategory,
          reasoning: `Static rule matched (worst-risk): ${worstRisk.rule.pattern}`,
        }
      : { action: 'abstain' as const, confidence: 0, reasoning: 'No static rule matched' };
  };
}

export function createGearArbiterStaticPlugin(
  config: StaticRuleArbiterConfig = { rules: DEFAULT_STATIC_RULES },
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/gear-arbiter-static',
      version: '0.1.0-alpha',
      description: 'Static rule-based gear arbiter',
      skandha: ['samjna', 'vijnana'],
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // Prefer ctx.config (from agent.json plugin config) over constructor config
      const ctxConfig = ctx.config as Partial<StaticRuleArbiterConfig> | undefined;
      const effectiveConfig = ctxConfig?.rules ? { rules: ctxConfig.rules } : config;
      const evaluate = createStaticRuleEvaluator(effectiveConfig);
      const arbiter: IGearArbiter = {
        id: 'static-rule-arbiter',
        priority: 10,
        evaluate,
      };
      return {
        gearArbiters: [arbiter],
      };
    },
  };
}

// Also export the evaluator for direct usage in tests
export { createStaticRuleEvaluator };

export default createGearArbiterStaticPlugin;
