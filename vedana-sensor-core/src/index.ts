/**
 * @openstarry-plugin/vedana-sensor-core
 *
 * Core vedana sensors: tool-outcome, safety-check, confidence-gap.
 * Each sensor maps real-time agent events to continuous hedonic signals.
 *
 * 二諦聲明 (Two Truths Declaration):
 * - 世俗諦: These sensors provide numerical feedback signals for PID control.
 * - 勝義諦: Tool outcomes are karma-phala (業果), safety signals are bhaya (怖畏),
 *   confidence gaps are vimati (疑惑). All vedana arise from contact (sparsha)
 *   and cease when conditions cease — they are empty of inherent existence.
 *
 * @skandha vedana (受蘊)
 * @criticality optional-degraded
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { ToolOutcomeSensor } from "./tool-outcome-sensor.js";
import { SafetyCheckSensor } from "./safety-check-sensor.js";
import { ConfidenceGapSensor } from "./confidence-gap-sensor.js";
import type { VedanaSensorCoreConfig } from "./types.js";

export function createVedanaSensorCorePlugin(): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/vedana-sensor-core',
      version: '0.1.0-alpha',
      description: 'Core vedana sensors: tool-outcome, safety-check, confidence-gap',
      skandha: 'vedana',
      criticality: 'optional-degraded',
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Partial<VedanaSensorCoreConfig> ?? {};
      const bus = ctx.bus;

      const toolSensor = new ToolOutcomeSensor('tool-outcome-1', config.toolOutcome, bus);
      const safetySensor = new SafetyCheckSensor('safety-check-1', config.safetyCheck, bus);
      const gapSensor = new ConfidenceGapSensor('confidence-gap-1', config.confidenceGap, bus);

      return {
        vedanaSensors: [toolSensor, safetySensor, gapSensor],
      };
    },
  };
}

export { ToolOutcomeSensor } from "./tool-outcome-sensor.js";
export { SafetyCheckSensor } from "./safety-check-sensor.js";
export { ConfidenceGapSensor } from "./confidence-gap-sensor.js";
export type { VedanaSensorCoreConfig, ToolOutcomeSensorConfig, SafetyCheckSensorConfig, ConfidenceGapSensorConfig } from "./types.js";
export default createVedanaSensorCorePlugin;
