/**
 * ConfidenceGapSensor — vimati-vedana (疑惑受).
 *
 * Feeling arising from decision uncertainty.
 * Subscribes to gear:arbiter_evaluated and gear:switch events via bus.
 * Reads arbiter confidence from bus events, NOT from historical buffer (WIENER C-1).
 *
 * @skandha vedana (受蘊)
 * @channel confidence-gap
 */

import type { EventBus, ChannelVedana } from "@openstarry/sdk";
import type { ConfidenceGapSensorConfig } from "./types.js";

/** Clamp a value to [min, max] with NaN guard. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

export class ConfidenceGapSensor {
  readonly skandha = 'vedana' as const;
  readonly id: string;
  readonly channel = 'confidence-gap';

  private readonly anxietyGapThreshold: number;
  private readonly comfortGapThreshold: number;
  private readonly maxNegativeValence: number;
  private readonly maxPositiveValence: number;

  private lastGap: number | null = null;

  constructor(id: string, config?: ConfidenceGapSensorConfig, bus?: EventBus) {
    this.id = id;
    this.anxietyGapThreshold = config?.anxietyGapThreshold ?? 0.1;
    this.comfortGapThreshold = config?.comfortGapThreshold ?? 0.3;
    this.maxNegativeValence = config?.maxNegativeValence ?? -0.5;
    this.maxPositiveValence = config?.maxPositiveValence ?? 0.3;

    if (bus) {
      bus.on('gear:arbiter_evaluated', (event) => {
        const payload = event.payload as { confidence?: number; threshold?: number } | undefined;
        if (payload?.confidence !== undefined && payload?.threshold !== undefined) {
          this.lastGap = payload.confidence - payload.threshold;
        }
      });
      bus.on('gear:switch', () => {
        // Reset gap on gear switch
        this.lastGap = null;
      });
    }
  }

  sense(_event: unknown): ChannelVedana {
    try {
      if (this.lastGap === null) {
        return { valence: 0, intensity: 0.1, type: 'upekkha', source: this.channel };
      }

      const gap = this.lastGap;
      let valence: number;
      let intensity: number;

      if (gap < this.anxietyGapThreshold) {
        // Near threshold — vimati (doubt)
        const t = clamp(gap / this.anxietyGapThreshold, 0, 1);
        valence = this.maxNegativeValence * (1 - t);
        intensity = 0.5;
      } else if (gap > this.comfortGapThreshold) {
        // Well above — prasada (clarity)
        valence = this.maxPositiveValence;
        intensity = 0.3;
      } else {
        // Middle zone — equanimity
        valence = 0;
        intensity = 0.1;
      }

      valence = clamp(valence, -1, 1);
      intensity = clamp(intensity, 0, 1);

      const type = valence < -0.1 ? 'dukkha' : valence > 0.1 ? 'sukha' : 'upekkha';
      return { valence, intensity, type, source: this.channel };
    } catch {
      return { valence: 0, intensity: 0, type: 'upekkha', source: this.channel };
    }
  }
}
