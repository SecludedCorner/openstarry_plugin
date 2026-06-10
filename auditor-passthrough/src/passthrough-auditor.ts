/**
 * PassthroughAuditor — delta=0 auditor for pipeline validation.
 *
 * Always returns delta=0 with a log. Used for integration testing and
 * as a reference IConfidenceAuditor implementation.
 *
 * @skandha vijnana (識蘊)
 * @see Plan30 Wave 4, Plan32 Wave 2 (extracted to plugin)
 */

import type {
  IConfidenceAuditor,
  ConfidenceAuditResult,
  RouteResult,
  AuditContext,
} from "@openstarry/sdk";

export function createPassthroughAuditor(id: string = 'passthrough-auditor'): IConfidenceAuditor {
  return {
    id,
    skandha: 'vijnana',

    audit(context: AuditContext | RouteResult): ConfidenceAuditResult {
      const routeResult = 'routeResult' in context ? context.routeResult : context;
      const gear = Number(routeResult.gear);
      const confidence = Number(routeResult.confidence);
      return {
        delta: 0,
        reasoning: `passthrough: no adjustment (gear=${Number.isFinite(gear) ? gear : 0}, confidence=${Number.isFinite(confidence) ? confidence : 0})`,
      };
    },
  };
}
