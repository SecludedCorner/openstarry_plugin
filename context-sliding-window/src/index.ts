export { createContextManager } from "./context.js";

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createContextManager } from "./context.js";

export interface SlidingWindowContextConfig {
  // Reserved for future configuration
}

export function createSlidingWindowContextPlugin(
  _config: SlidingWindowContextConfig = {},
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/context-sliding-window',
      version: '0.1.0-alpha',
      description: 'Sliding window context manager — keeps last N user turns plus system messages',
      skandha: 'samjna',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const contextManager = createContextManager();
      return { contextManager };
    },
  };
}
