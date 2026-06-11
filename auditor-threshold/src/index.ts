export { createThresholdAuditor, DEFAULT_THRESHOLD_RULES } from "./threshold-auditor.js";
export type { ThresholdAuditRule } from "./threshold-auditor.js";

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createThresholdAuditor, DEFAULT_THRESHOLD_RULES } from "./threshold-auditor.js";
import type { ThresholdAuditRule } from "./threshold-auditor.js";

export interface ThresholdAuditorConfig {
  readonly rules?: readonly ThresholdAuditRule[];
  readonly id?: string;
}

export function createThresholdAuditorPlugin(
  config: ThresholdAuditorConfig = {},
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/auditor-threshold',
      version: '0.1.0-alpha',
      description: 'Risk-based confidence auditor with configurable threshold rules',
      skandha: 'vijnana',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const rules = config.rules ?? DEFAULT_THRESHOLD_RULES;
      const id = config.id ?? 'threshold-auditor';
      const auditor = createThresholdAuditor(rules, id);
      return { auditor };
    },
  };
}
