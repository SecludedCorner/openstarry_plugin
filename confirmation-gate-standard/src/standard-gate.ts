/**
 * StandardConfirmationGate — rule-based pre-execution confirmation.
 *
 * Bypass evaluation order (D2-R3):
 * 1. alwaysConfirmTools → if match: ask_user (highest priority)
 * 2. neverConfirmTools → if match: approve
 * 3. bypassCategories → if riskCategory in list: approve
 * 4. bypassGears → if gear in list: approve
 * 5. Default: ask_user
 *
 * WIENER C-2: timeout default = deny (mechanism value, non-negotiable).
 * Gate does NOT accumulate state across evaluations (C-1, C-3).
 *
 * @skandha samskara (行蘊)
 * @see Plan36b §3.5
 */

import type {
  IConfirmationGate,
  ConfirmationRequest,
  ConfirmationDecision,
  RiskCategory,
} from "@openstarry/sdk";
import { DEFAULT_CONFIRMATION_GATE_CONFIG } from "@openstarry/sdk";
import type { StandardGateConfig } from "./types.js";

export function createStandardConfirmationGate(
  config?: StandardGateConfig,
): IConfirmationGate {
  const userPromptTimeoutMs = config?.userPromptTimeoutMs
    ?? DEFAULT_CONFIRMATION_GATE_CONFIG.userPromptTimeoutMs;
  const bypassCategories: readonly RiskCategory[] = config?.bypassCategories
    ?? DEFAULT_CONFIRMATION_GATE_CONFIG.bypassCategories;
  const bypassGears: readonly number[] = config?.bypassGears
    ?? DEFAULT_CONFIRMATION_GATE_CONFIG.bypassGears;
  const alwaysConfirmTools: readonly string[] = config?.alwaysConfirmTools
    ?? DEFAULT_CONFIRMATION_GATE_CONFIG.alwaysConfirmTools;
  const neverConfirmTools: readonly string[] = config?.neverConfirmTools
    ?? DEFAULT_CONFIRMATION_GATE_CONFIG.neverConfirmTools;
  // V-2 fail-closed: with no interactive human, ask_user would hang the loop
  // until the timeout then default-deny anyway — deny immediately instead.
  const interactive = config?.interactive
    ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

  /** ask_user when a human can answer; immediate deny otherwise (fail-closed). */
  function askOrDeny(prompt: string): ConfirmationDecision {
    if (interactive) {
      return { action: 'ask_user', prompt, timeoutMs: userPromptTimeoutMs };
    }
    return {
      action: 'deny',
      reasoning: 'non-interactive session — confirmation unavailable (fail-closed)',
    };
  }

  return {
    skandha: 'samskara',
    id: 'standard-confirmation-gate',

    evaluate(request: ConfirmationRequest): ConfirmationDecision {
      const { toolName, riskCategory, gear } = request;

      // 1. alwaysConfirmTools (highest priority)
      if (alwaysConfirmTools.includes(toolName)) {
        return askOrDeny(`Tool "${toolName}" requires confirmation (always-confirm rule).`);
      }

      // 2. neverConfirmTools
      if (neverConfirmTools.includes(toolName)) {
        return { action: 'approve', reasoning: `Tool "${toolName}" is in never-confirm list` };
      }

      // 3. bypassCategories
      if (riskCategory && bypassCategories.includes(riskCategory)) {
        return { action: 'approve', reasoning: `Risk category "${riskCategory}" is bypassed` };
      }

      // 4. bypassGears
      if (gear !== undefined && bypassGears.includes(gear)) {
        return { action: 'approve', reasoning: `Gear ${gear} is bypassed` };
      }

      // 5. Default: ask_user (or fail-closed deny when non-interactive)
      return askOrDeny(
        `Confirm execution of "${toolName}"${riskCategory ? ` (risk: ${riskCategory})` : ''}?`,
      );
    },
  };
}
