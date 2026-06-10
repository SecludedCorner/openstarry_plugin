/**
 * SafetyCheckSensor — bhaya-vedana (怖畏受).
 *
 * Feeling arising from danger perception.
 * Subscribes to SAFETY_WARNING and SAFETY_LOCKOUT events via bus.
 * Intensity decays exponentially over time.
 *
 * CRITICAL: warning intensity (0.6) MUST stay below VedanaEmergency
 * intensityThreshold (0.8) — D4-R8 verification item.
 *
 * Post-lockout vedana = upeksha, NOT sukha.
 * "Returning to safety is not pleasure; it is cessation of suffering."
 *
 * @skandha vedana (受蘊)
 * @channel safety-check
 */

import type { EventBus, ChannelVedana } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { SafetyCheckSensorConfig } from "./types.js";

/** Clamp a value to [min, max] with NaN guard. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

export class SafetyCheckSensor {
  readonly skandha = 'vedana' as const;
  readonly id: string;
  readonly channel = 'safety-check';

  private readonly warningValence: number;
  private readonly lockoutValence: number;
  private readonly decayHalfLifeMs: number;

  private lastEventValence = 0;
  private lastEventIntensity = 0;
  private lastEventTime = 0;

  constructor(id: string, config?: SafetyCheckSensorConfig, bus?: EventBus) {
    this.id = id;
    this.warningValence = config?.warningValence ?? -0.4;
    this.lockoutValence = config?.lockoutValence ?? -0.9;
    this.decayHalfLifeMs = config?.decayHalfLifeMs ?? 30000;

    if (bus) {
      bus.on(AgentEventType.SAFETY_WARNING, () => {
        this.lastEventValence = this.warningValence;
        this.lastEventIntensity = 0.6;
        this.lastEventTime = Date.now();
      });
      bus.on(AgentEventType.SAFETY_LOCKOUT, () => {
        this.lastEventValence = this.lockoutValence;
        this.lastEventIntensity = 1.0;
        this.lastEventTime = Date.now();
      });
    }
  }

  sense(_event: unknown): ChannelVedana {
    try {
      if (this.lastEventTime === 0) {
        return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
      }

      const elapsed = Date.now() - this.lastEventTime;
      const decayFactor = Math.pow(0.5, elapsed / this.decayHalfLifeMs);
      const intensity = clamp(this.lastEventIntensity * decayFactor, 0, 1);
      const valence = clamp(this.lastEventValence * decayFactor, -1, 1);

      if (intensity < 0.01) {
        return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
      }

      const type = valence < -0.1 ? 'dukkha' : 'upekkha';
      return { valence, intensity, type, source: this.channel };
    } catch {
      return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
    }
  }
}
