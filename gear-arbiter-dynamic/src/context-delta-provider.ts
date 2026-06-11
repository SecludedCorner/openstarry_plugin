/**
 * context-delta-provider — per-category delta correction for CalibrationBridge.
 *
 * When enabled, applies an additive correction to each incoming delta before it
 * is recorded in the StateTracker. The correction is:
 *
 *   correctedDelta = baseDelta + (categoryFactor - DELTA_SCALING_FACTOR)
 *
 * This is an additive (not multiplicative) correction so that when all factors
 * equal DELTA_SCALING_FACTOR (0.055) the provider is an identity function —
 * consistent with the HYPOTHESIS baseline that all categories start equal.
 * (O5 §6.3, Plan45 W2-2)
 *
 * Rule #55 invariant: destructive delta <= 0 is preserved downstream by the
 * StateTracker and DynamicArbiter (they rely on raw sign), and MUST NOT be
 * violated by this provider. See createContextDeltaProvider for the guard.
 *
 * Rule #59: All DEFAULT_CATEGORY_FACTORS values are HYPOTHESIS (initial=0.055,
 * no behavioral change). They will be calibrated from empirical W2 data.
 *
 * @see Plan45 Architecture_Spec §1 (Frozen Interfaces)
 * @see O5_plan45_engineering_spec §6
 */

import { DELTA_SCALING_FACTOR } from './calibration-bridge.js';

// ─── Frozen Types (Architecture_Spec §1) ──────────────────────────────────────

/**
 * Per-category delta correction configuration.
 * enabled=false (default) → identity provider, no behavioral change.
 */
export interface ContextDeltaConfig {
  /** Enable context-dependent delta correction. Default: false. */
  readonly enabled?: boolean;
  /**
   * Per-category scaling factor overrides.
   * Keys should match risk category strings used in audit:tool_audited events.
   * All values are HYPOTHESIS (Rule #59): calibrated from empirical data.
   */
  readonly categoryFactors?: Readonly<Record<string, number>>;
  /**
   * Default factor for categories not listed in categoryFactors.
   * Default: 0.055 (= DELTA_SCALING_FACTOR = no change). HYPOTHESIS (Rule #59).
   */
  readonly defaultFactor?: number;
}

// ─── Provider Type ────────────────────────────────────────────────────────────

/**
 * Function signature for context-dependent delta correction.
 * Returns corrected delta for a given category and base delta value.
 */
export type ContextDeltaProvider = (category: string, baseDelta: number) => number;

// ─── Hypothesis Baseline ──────────────────────────────────────────────────────

/**
 * Default per-category factors. All equal to DELTA_SCALING_FACTOR (0.055).
 * HYPOTHESIS (Rule #59) — baseline values; to be calibrated with empirical W2 data per D9-Q27.
 * No behavioral change at baseline. Values are placeholders for empirical calibration
 * from W2 perturbation diagnostic data.
 */
export const DEFAULT_CATEGORY_FACTORS: Readonly<Record<string, number>> = {
  informational:   0.055,  // HYPOTHESIS: baseline unchanged
  read_only:       0.055,  // HYPOTHESIS: baseline unchanged
  state_modifying: 0.055,  // HYPOTHESIS: baseline unchanged (monitoring-only)
  destructive:     0.055,  // HYPOTHESIS: baseline unchanged (monitoring-only)
};

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a context-dependent delta provider from configuration.
 *
 * When disabled: returns an identity function (baseDelta unchanged).
 * When enabled: applies additive correction per category.
 *
 * Rule #55 guard: if the corrected delta would flip a negative (destructive)
 * delta to positive, the correction is skipped and the original baseDelta is
 * returned. This preserves the destructive delta <= 0 invariant at the source.
 * (The downstream DynamicArbiter.evaluate() also checks this, but defense-in-depth.)
 *
 * @param config ContextDeltaConfig
 * @returns ContextDeltaProvider function
 */
export function createContextDeltaProvider(config: ContextDeltaConfig): ContextDeltaProvider {
  if (!config.enabled) {
    // Identity: pass deltas through unchanged
    return (_category: string, baseDelta: number) => baseDelta;
  }

  return (category: string, baseDelta: number): number => {
    const factor = config.categoryFactors?.[category]
      ?? config.defaultFactor
      ?? DELTA_SCALING_FACTOR;

    // Additive correction (O5 §6.3)
    const corrected = baseDelta + (factor - DELTA_SCALING_FACTOR);

    // Rule #55: destructive delta <= 0 invariant guard.
    // If baseDelta was negative (destructive) and the correction would push it
    // to >= 0, return the original baseDelta to preserve the invariant.
    if (baseDelta < 0 && corrected >= 0) {
      return baseDelta;
    }

    return corrected;
  };
}
