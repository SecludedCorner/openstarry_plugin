/**
 * VedanaSensorCore config types.
 *
 * All config is plugin-local (NOT IAgentConfig).
 * @skandha vedana (受蘊)
 */

export interface ToolOutcomeSensorConfig {
  readonly windowSize?: number;        // default: 5
  readonly successValence?: number;     // default: +0.3
  readonly errorValence?: number;       // default: -0.5
  readonly successIntensity?: number;   // default: 0.3
  readonly errorIntensity?: number;     // default: 0.7
}

export interface SafetyCheckSensorConfig {
  readonly warningValence?: number;     // default: -0.4
  readonly lockoutValence?: number;     // default: -0.9
  readonly decayHalfLifeMs?: number;    // default: 30000
}

export interface ConfidenceGapSensorConfig {
  readonly anxietyGapThreshold?: number;  // default: 0.1
  readonly comfortGapThreshold?: number;  // default: 0.3
  readonly maxNegativeValence?: number;   // default: -0.5
  readonly maxPositiveValence?: number;   // default: +0.3
}

export interface VedanaSensorCoreConfig {
  readonly toolOutcome?: ToolOutcomeSensorConfig;
  readonly safetyCheck?: SafetyCheckSensorConfig;
  readonly confidenceGap?: ConfidenceGapSensorConfig;
}
