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

import type { AgentEvent, IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import { createStandardConfirmationGate } from "./standard-gate.js";
import type { StandardGateConfig } from "./types.js";

/**
 * The loop's confirmation-flow TOOL_BLOCKED reasons (loop.ts gate phase):
 * "User denied: …" / "Confirmation timeout (default-deny)" /
 * "Confirmation gate denied: …" / "Confirmation gate error: …".
 * Volition vetoes ("volition veto (…)") deliberately do NOT match.
 */
function isConfirmationDenial(reason: string): boolean {
  return reason.startsWith("User denied") || reason.includes("Confirmation");
}

export function createConfirmationGateStandardPlugin(
  factoryConfig: StandardGateConfig = {},
): IPlugin {
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
      // agent.json plugin config wins over factory config (standard pattern).
      const config: Partial<StandardGateConfig> = {
        ...factoryConfig,
        ...((ctx.config as Partial<StandardGateConfig>) ?? {}),
      };
      const gate = createStandardConfirmationGate(config);

      // V-2 model feedback: a denied call gets no tool_result (core loop shape),
      // so the model would silently lose the action. Bridge the denial back
      // through the EXISTING pushInput seam — the next turn tells the model the
      // user declined, so it can adapt instead of retrying blindly. Deduped per
      // tool within a short window (one plan can deny several calls at once).
      let unsub: (() => void) | null = null;
      if (config.notifyModelOnDeny !== false) {
        const recentlyNotified = new Map<string, number>();
        unsub = ctx.bus.on(AgentEventType.TOOL_BLOCKED, (event: AgentEvent) => {
          const payload = event.payload as { name?: string; reason?: string } | undefined;
          const reason = payload?.reason ?? "";
          if (!isConfirmationDenial(reason)) return;
          const name = payload?.name ?? "tool";
          const now = Date.now();
          const last = recentlyNotified.get(name) ?? 0;
          if (now - last < 3000) return;
          recentlyNotified.set(name, now);
          ctx.pushInput({
            source: "confirmation-gate",
            inputType: "user_input",
            data:
              `[system notice] The proposed "${name}" call was DECLINED (${reason}). ` +
              `Do not retry it; acknowledge and adjust your approach.`,
          });
        });
      }

      return {
        confirmationGate: gate,
        dispose: () => {
          unsub?.();
        },
      };
    },
  };
}

export { createStandardConfirmationGate } from "./standard-gate.js";
export type { StandardGateConfig } from "./types.js";
export default createConfirmationGateStandardPlugin;
