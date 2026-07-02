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
  /**
   * V-2 fail-closed: whether an interactive human can actually answer a y/n
   * prompt. When false, every would-be ask_user becomes an immediate deny
   * (no hang on piped/headless stdin, no pointless timeout wait). Default:
   * auto-detected from process.stdin/stdout TTY-ness at factory time.
   */
  readonly interactive?: boolean;
  /**
   * V-2 model feedback: when a confirmation is denied (user said no, timeout,
   * or non-interactive fail-closed), push a note into the agent's input queue
   * via ctx.pushInput so the MODEL learns the action was declined and adapts —
   * the loop itself gives a vetoed/denied call no tool_result (core untouched).
   * Default true.
   */
  readonly notifyModelOnDeny?: boolean;
}
