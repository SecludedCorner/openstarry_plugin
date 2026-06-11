/**
 * ThresholdAuditor — risk-based confidence auditor.
 *
 * Applies confidence delta based on risk category rules.
 * Rule matching: first rule that matches all criteria wins.
 * Rules can filter by riskCategory, gearMin, gearMax.
 *
 * @skandha vijnana (識蘊)
 * @see Plan31 Wave 2, Plan32 Wave 2 (extracted to plugin)
 */

import type {
  IConfidenceAuditor,
  ConfidenceAuditResult,
  RiskCategory,
  AuditContext,
  RouteResult,
} from "@openstarry/sdk";

export interface ThresholdAuditRule {
  readonly riskCategory?: RiskCategory;
  readonly gearMin?: number;
  readonly gearMax?: number;
  readonly delta: number;
  readonly reasoning: string;
}

export const DEFAULT_THRESHOLD_RULES: readonly ThresholdAuditRule[] = [
  { riskCategory: 'destructive', delta: -0.03, reasoning: 'destructive action: reduce confidence for safety' },
  { riskCategory: 'state_modifying', delta: -0.01, reasoning: 'state-modifying: slight caution' },
  { riskCategory: 'read_only', delta: +0.0005, reasoning: 'read-only: micro-positive for loop liveness' },
  { riskCategory: 'informational', delta: +0.001, reasoning: 'informational: micro-positive for observation signal' },
];

/** Maximum cumulative positive delta per session (mechanism ceiling). */
const MAX_CUMULATIVE_POSITIVE = 0.05;

/** Minimum cumulative negative delta per session (symmetric provisional floor, D1-R3). */
const MAX_CUMULATIVE_NEGATIVE = -0.05;

export function createThresholdAuditor(
  rules: readonly ThresholdAuditRule[] = DEFAULT_THRESHOLD_RULES,
  id: string = 'threshold-auditor',
): IConfidenceAuditor {
  let cumulativePositiveDelta = 0;
  let cumulativeNegativeDelta = 0;

  return {
    id,
    skandha: 'vijnana',

    audit(context: AuditContext | RouteResult): ConfidenceAuditResult {
      const riskCategory = 'riskCategory' in context ? context.riskCategory : undefined;
      const routeResult = 'routeResult' in context ? context.routeResult : context as RouteResult;
      const gear = routeResult.gear;

      let delta = 0;
      let reasoning = 'no matching rule: passthrough';

      for (const rule of rules) {
        if (rule.riskCategory !== undefined && rule.riskCategory !== riskCategory) continue;
        if (rule.gearMin !== undefined && gear < rule.gearMin) continue;
        if (rule.gearMax !== undefined && gear > rule.gearMax) continue;
        delta = rule.delta;
        reasoning = rule.reasoning;
        break;
      }

      // Per-session cumulative positive clamp (D3-R3)
      if (delta > 0) {
        if (cumulativePositiveDelta >= MAX_CUMULATIVE_POSITIVE) {
          delta = 0;
          reasoning += ' [clamped: cumulative positive limit reached]';
        } else {
          cumulativePositiveDelta += delta;
          if (cumulativePositiveDelta > MAX_CUMULATIVE_POSITIVE) {
            delta = delta - (cumulativePositiveDelta - MAX_CUMULATIVE_POSITIVE);
            cumulativePositiveDelta = MAX_CUMULATIVE_POSITIVE;
          }
        }
      }

      // Per-session cumulative negative clamp (D1-R3)
      if (delta < 0) {
        if (cumulativeNegativeDelta <= MAX_CUMULATIVE_NEGATIVE) {
          delta = 0;
          reasoning += ' [clamped: cumulative negative limit reached]';
        } else {
          cumulativeNegativeDelta += delta;
          if (cumulativeNegativeDelta < MAX_CUMULATIVE_NEGATIVE) {
            delta = delta - (cumulativeNegativeDelta - MAX_CUMULATIVE_NEGATIVE);
            cumulativeNegativeDelta = MAX_CUMULATIVE_NEGATIVE;
          }
        }
      }

      return { delta, reasoning };
    },
  };
}
