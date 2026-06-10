/**
 * ToolOutcomeSensor — karma-phala vedana (業果受).
 *
 * Feeling arising from tool execution consequences.
 * Subscribes to TOOL_RESULT and TOOL_ERROR events via bus.
 * Maintains a sliding window of recent outcomes.
 *
 * @skandha vedana (受蘊)
 * @channel tool-outcome
 */

import type { EventBus, ChannelVedana } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { ToolOutcomeSensorConfig } from "./types.js";

/** Clamp a value to [min, max] with NaN guard. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

interface OutcomeEntry {
  valence: number;
  intensity: number;
}

export class ToolOutcomeSensor {
  readonly skandha = 'vedana' as const;
  readonly id: string;
  readonly channel = 'tool-outcome';

  private readonly windowSize: number;
  private readonly successValence: number;
  private readonly errorValence: number;
  private readonly successIntensity: number;
  private readonly errorIntensity: number;
  private readonly window: OutcomeEntry[] = [];

  constructor(id: string, config?: ToolOutcomeSensorConfig, bus?: EventBus) {
    this.id = id;
    this.windowSize = config?.windowSize ?? 5;
    this.successValence = config?.successValence ?? 0.3;
    this.errorValence = config?.errorValence ?? -0.5;
    this.successIntensity = config?.successIntensity ?? 0.3;
    this.errorIntensity = config?.errorIntensity ?? 0.7;

    if (bus) {
      bus.on(AgentEventType.TOOL_RESULT, () => {
        this.pushEntry({ valence: this.successValence, intensity: this.successIntensity });
      });
      bus.on(AgentEventType.TOOL_ERROR, () => {
        this.pushEntry({ valence: this.errorValence, intensity: this.errorIntensity });
      });
    }
  }

  private pushEntry(entry: OutcomeEntry): void {
    this.window.push(entry);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
  }

  sense(_event: unknown): ChannelVedana {
    try {
      if (this.window.length === 0) {
        return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
      }

      let totalValence = 0;
      let maxIntensity = 0;
      for (const entry of this.window) {
        totalValence += entry.valence;
        if (entry.intensity > maxIntensity) maxIntensity = entry.intensity;
      }

      const avgValence = clamp(totalValence / this.window.length, -1, 1);
      const intensity = clamp(maxIntensity, 0, 1);

      const type = avgValence < -0.1 ? 'dukkha' : avgValence > 0.1 ? 'sukha' : 'upekkha';
      return { valence: avgValence, intensity, type, source: this.channel };
    } catch {
      return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
    }
  }
}
