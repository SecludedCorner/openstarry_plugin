/**
 * Three-layer rule engine for IVolition v1.
 *
 * Hard layer: Risk-category-based audit rules (śīla — 教誡)
 * Soft layer: Pattern-matching rules (upāya — 善巧)
 * Heuristic layer: Repetition detection (smṛti — 正念)
 *
 * Precedence: hard > soft > heuristic.
 * Hard = MUST audit (not MUST veto) — guides into audit flow, not unconditional block.
 *
 * @skandha vijnana (識蘊)
 * @see Plan28: IVolition v1 + Safety Hardening
 */

import type {
  IVolition,
  IVijnana,
  PlanDeliberationInput,
  PlanDeliberationResult,
  ActionDeliberationInput,
  ActionDeliberationResult,
  ToolCallInfo,
  RiskCategory,
  DeliberationContext,
} from "@openstarry/sdk";
import { safeRegexTest } from "@openstarry/shared";

export interface HardRule {
  readonly mustAuditCategories: readonly RiskCategory[];
}

export interface SoftRule {
  readonly pattern: string | RegExp;
  readonly action: 'veto' | 'allow' | 'audit';
  readonly reasoning: string;
}

export interface HeuristicRule {
  readonly maxRepetitions: number;
  readonly windowSize: number;
}

/**
 * How hard-rule hits are handled (V-2):
 * - 'block'   — veto + TOOL_BLOCKED (V-1 behavior; safe default).
 * - 'confirm' — do NOT veto; pass the call through so the confirmation gate
 *   (which the loop runs AFTER volition) can ask the user. REQUIRES a
 *   confirmationGate plugin (e.g. confirmation-gate-standard) in the same
 *   config — without one the call executes unconfirmed (fail-open), so
 *   'confirm' is never the default.
 * - 'allow'   — hard rules disabled entirely.
 * Soft rules and the heuristic anti-loop stay active in every mode.
 */
export type VolitionMode = 'block' | 'confirm' | 'allow';

export interface VolitionRuleEngineConfig {
  readonly mode?: VolitionMode;
  readonly hardRules?: readonly HardRule[];
  readonly softRules?: readonly SoftRule[];
  readonly heuristicRules?: readonly HeuristicRule[];
  /** Fallback riskCategory when arbiter doesn't provide one [Y1] */
  readonly defaultRiskCategory?: RiskCategory;
}

export const DEFAULT_VOLITION_RULE_ENGINE_CONFIG: VolitionRuleEngineConfig = {
  hardRules: [{ mustAuditCategories: ['destructive', 'state_modifying'] }],
  softRules: [],
  heuristicRules: [{ maxRepetitions: 5, windowSize: 10 }],
  defaultRiskCategory: 'read_only',
};

/** A veto that is about to take effect — surfaced so the host can make it VISIBLE. */
export interface VolitionVetoNotice {
  readonly toolName: string;
  readonly reasoning: string;
  /** 'plan' = dropped by deliberatePlan's modifiedPlan filter; 'action' = per-action veto. */
  readonly phase: 'plan' | 'action';
}

/**
 * Observability hooks (C#1 feel-test closure → V-1): the loop applies a
 * plan-level veto as a SILENT filter (modifiedPlan → calls dropped, no
 * tool_result, no user message). onVeto lets the plugin factory surface every
 * veto (e.g. emit TOOL_BLOCKED) so a veto is never a silent disappearance.
 */
export interface VolitionRuleEngineHooks {
  readonly onVeto?: (notice: VolitionVetoNotice) => void;
}

interface RuleCheckResult {
  veto: boolean;
  reasoning: string;
}

function checkHardRules(
  toolName: string,
  riskCategory: RiskCategory,
  hardRules: readonly HardRule[],
): RuleCheckResult | null {
  for (const rule of hardRules) {
    if (rule.mustAuditCategories.includes(riskCategory)) {
      return {
        veto: true,
        reasoning: `Hard rule audit: tool "${toolName}" has riskCategory "${riskCategory}" which requires audit`,
      };
    }
  }
  return null;
}

function checkSoftRules(
  toolName: string,
  softRules: readonly SoftRule[],
): RuleCheckResult | null {
  for (const rule of softRules) {
    const matches = typeof rule.pattern === 'string'
      ? toolName.includes(rule.pattern)
      : safeRegexTest(rule.pattern, toolName);
    if (matches) {
      if (rule.action === 'allow') {
        return { veto: false, reasoning: rule.reasoning };
      }
      return { veto: true, reasoning: rule.reasoning };
    }
  }
  return null;
}

function checkHeuristicRules(
  toolName: string,
  actionHistory: readonly { readonly name: string }[],
  heuristicRules: readonly HeuristicRule[],
): RuleCheckResult | null {
  for (const rule of heuristicRules) {
    const window = actionHistory.slice(-rule.windowSize);
    const count = window.filter(a => a.name === toolName).length;
    if (count >= rule.maxRepetitions) {
      return {
        veto: true,
        reasoning: `Heuristic: tool "${toolName}" appeared ${count} times in last ${rule.windowSize} actions (limit: ${rule.maxRepetitions})`,
      };
    }
  }
  return null;
}

function resolveRiskCategory(
  deliberationContext: DeliberationContext | undefined,
  defaultRiskCategory: RiskCategory,
): RiskCategory {
  return deliberationContext?.routeResult.riskCategory ?? defaultRiskCategory;
}

function evaluateAction(
  toolName: string,
  deliberationContext: DeliberationContext | undefined,
  config: VolitionRuleEngineConfig,
): RuleCheckResult {
  const defaultCategory = config.defaultRiskCategory ?? 'read_only';
  const riskCategory = resolveRiskCategory(deliberationContext, defaultCategory);
  const actionHistory = deliberationContext?.actionHistory ?? [];

  // Precedence: hard > soft > heuristic.
  // V-2 mode: 'block' vetoes on a hard-rule hit; 'confirm' passes the call
  // through to the downstream confirmation gate; 'allow' skips hard rules.
  const mode = config.mode ?? 'block';
  const hardResult =
    mode === 'block' ? checkHardRules(toolName, riskCategory, config.hardRules ?? []) : null;
  if (hardResult) return hardResult;

  const softResult = checkSoftRules(toolName, config.softRules ?? []);
  if (softResult) return softResult;

  const heuristicResult = checkHeuristicRules(toolName, actionHistory, config.heuristicRules ?? []);
  if (heuristicResult) return heuristicResult;

  return { veto: false, reasoning: 'No rule triggered — allow' };
}

export function createRuleEngineVolition(
  config: VolitionRuleEngineConfig = DEFAULT_VOLITION_RULE_ENGINE_CONFIG,
  hooks: VolitionRuleEngineHooks = {},
): IVolition {
  // A notifier crash must never break deliberation (observability is best-effort).
  const notifyVeto = (notice: VolitionVetoNotice): void => {
    try {
      hooks.onVeto?.(notice);
    } catch {
      /* swallow */
    }
  };

  return {
    skandha: 'vijnana',

    async deliberatePlan(input: PlanDeliberationInput): Promise<PlanDeliberationResult> {
      // If no deliberation context, allow all (backward compat)
      if (!input.deliberationContext) {
        return { modifiedPlan: null, reasoning: 'No deliberation context — allow all (v0 compat)' };
      }

      const results = input.proposedActions.map(action =>
        evaluateAction(action.name, input.deliberationContext, config)
      );

      const anyVeto = results.some(r => r.veto);
      if (!anyVeto) {
        return { modifiedPlan: null, reasoning: 'All actions passed rule engine' };
      }

      // Filter to only allowed actions
      const allowedActions: ToolCallInfo[] = [];
      const reasons: string[] = [];
      for (let i = 0; i < input.proposedActions.length; i++) {
        if (!results[i].veto) {
          allowedActions.push(input.proposedActions[i]);
        } else {
          reasons.push(results[i].reasoning);
          // The loop applies modifiedPlan as a silent filter — surface the drop.
          notifyVeto({
            toolName: input.proposedActions[i].name,
            reasoning: results[i].reasoning,
            phase: 'plan',
          });
        }
      }

      return {
        modifiedPlan: allowedActions,
        reasoning: `Rule engine filtered plan: ${reasons.join('; ')}`,
      };
    },

    async deliberateAction(input: ActionDeliberationInput): Promise<ActionDeliberationResult> {
      // If no deliberation context, allow (backward compat)
      if (!input.deliberationContext) {
        return { veto: false, alternative: null, reasoning: 'No deliberation context — allow (v0 compat)' };
      }

      const result = evaluateAction(
        input.proposedAction.name,
        input.deliberationContext,
        config,
      );

      if (result.veto) {
        notifyVeto({
          toolName: input.proposedAction.name,
          reasoning: result.reasoning,
          phase: 'action',
        });
      }

      return {
        veto: result.veto,
        alternative: null,
        reasoning: result.reasoning,
      };
    },
  };
}
