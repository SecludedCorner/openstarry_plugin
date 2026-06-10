export { createPassthroughAuditor } from "./passthrough-auditor.js";

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createPassthroughAuditor } from "./passthrough-auditor.js";

export interface PassthroughAuditorConfig {
  readonly id?: string;
}

export function createPassthroughAuditorPlugin(
  config: PassthroughAuditorConfig = {},
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/auditor-passthrough',
      version: '0.1.0-alpha',
      description: 'Delta-zero passthrough auditor for testing and reference',
      skandha: 'vijnana',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const auditor = createPassthroughAuditor(config.id);
      return { auditor };
    },
  };
}
