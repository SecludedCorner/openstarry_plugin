export { createDefaultLoopQualityMonitor } from "./default-loop-quality-monitor.js";
export type { DefaultMonitorConfig } from "./default-loop-quality-monitor.js";

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createDefaultLoopQualityMonitor } from "./default-loop-quality-monitor.js";
import type { DefaultMonitorConfig } from "./default-loop-quality-monitor.js";

export interface LoopQualityMonitorConfig {
  readonly windowSize?: number;
  readonly warmupCount?: number;
}

export function createLoopQualityMonitorPlugin(
  config: LoopQualityMonitorConfig = {},
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/monitor-loop-quality',
      version: '0.1.0-alpha',
      description: 'Default 4-dimensional loop quality monitor with sliding window',
      skandha: 'vijnana',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const monitorConfig: DefaultMonitorConfig = {
        windowSize: config.windowSize,
        warmupCount: config.warmupCount,
      };
      const monitor = createDefaultLoopQualityMonitor(monitorConfig);
      return { monitors: [monitor] };
    },
  };
}
