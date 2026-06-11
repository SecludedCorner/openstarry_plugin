/**
 * perturbation-diagnostic — sensitivity analysis for shadow gear decisions.
 *
 * Perturbs the most-recent delta by ±1 and observes whether the shadow gear
 * changes. This is an **output-only diagnostic**: it never modifies the main
 * evaluation path. All values that flow through the normal CalibrationBridge
 * pipeline are unchanged. (Plan45 W2-1)
 *
 * Cross-validation note (O5 §6.4 / W2-3):
 *   If this diagnostic reports high sensitivity (sensitive=true) for a specific
 *   category, that category's context-delta factor may be over-fitted to the
 *   boundary region of the gear-switch threshold. In such cases, the research
 *   team should review the ContextDeltaConfig.categoryFactors entry for that
 *   category and consider adjusting it to move the operating point further from
 *   the threshold, reducing brittleness.
 *
 * @see Plan45 Architecture_Spec §1 (Frozen Interfaces)
 * @see O5_plan45_engineering_spec §5
 */

import { computeShadowDecision } from './shadow-decision.js';

// ─── Frozen Types (Architecture_Spec §1) ──────────────────────────────────────

/** Perturbation result for a single direction ('+1' or '-1'). */
export interface PerturbationResult {
  readonly direction: '+1' | '-1';
  readonly originalGear: number;
  readonly perturbedGear: number;
  readonly gearChanged: boolean;
  readonly originalMean: number;
  readonly perturbedMean: number;
}

/**
 * Complete perturbation diagnostic for one shadow snapshot.
 * sensitive=true if EITHER ±1 shift caused a gear change.
 */
export interface PerturbationDiagnostic {
  readonly timestamp: number;
  readonly category: string;
  readonly plusOne: PerturbationResult;
  readonly minusOne: PerturbationResult;
  /** true if either direction changed gear — indicates decision boundary proximity. */
  readonly sensitive: boolean;
}

/**
 * Configuration for PerturbationDiagnostic integration.
 * Pass to CalibrationBridge via PerturbationConfig.
 */
export interface PerturbationConfig {
  /** Enable perturbation diagnostic. Default: false. */
  readonly enabled?: boolean;
  /** Callback invoked when a sensitive diagnostic is detected. */
  readonly onDiagnostic?: (d: PerturbationDiagnostic) => void;
}

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Compute perturbation diagnostic for a shadow decision.
 *
 * Pure function: deterministic, no side effects, no mutation.
 * Safe to call multiple times with the same inputs — always returns equal output.
 *
 * Algorithm:
 *   1. Run computeShadowDecision with original deltas.
 *   2. +1 perturbation: copy deltas, increment last element by 1, re-run.
 *   3. -1 perturbation: copy deltas, decrement last element by 1, re-run.
 *   4. Compute arithmetic means of each delta array.
 *   5. Return diagnostic: sensitive=true if any gear changed.
 *
 * Edge-case: empty deltas array — perturbation arrays also remain empty;
 * computeShadowDecision will abstain (returns {shadowGear: gear, abstains: true}).
 *
 * @param deltas    Recent delta history (from StateTracker.getRecentDeltas())
 * @param totalObs  Total observation count (from StateTracker.getTotalObservations())
 * @param gear      Current arbiter gear
 * @param dwell     Current dwell counter
 * @param category  Risk category label (for diagnostic tagging only)
 */
export function computePerturbationDiagnostic(
  deltas: readonly number[],
  totalObs: number,
  gear: number,
  dwell: number,
  category: string,
): PerturbationDiagnostic {
  // Original shadow decision
  const original = computeShadowDecision(deltas, totalObs, gear, dwell);

  // +1 perturbation: shift last delta up by 1
  const deltasPlus = [...deltas];
  if (deltasPlus.length > 0) {
    deltasPlus[deltasPlus.length - 1] += 1;
  }
  const plusResult = computeShadowDecision(deltasPlus, totalObs, gear, dwell);

  // -1 perturbation: shift last delta down by 1
  const deltasMinus = [...deltas];
  if (deltasMinus.length > 0) {
    deltasMinus[deltasMinus.length - 1] -= 1;
  }
  const minusResult = computeShadowDecision(deltasMinus, totalObs, gear, dwell);

  // Compute arithmetic means (0 for empty arrays)
  const originalMean = deltas.length > 0
    ? deltas.reduce((a, b) => a + b, 0) / deltas.length
    : 0;
  const plusMean = deltasPlus.length > 0
    ? deltasPlus.reduce((a, b) => a + b, 0) / deltasPlus.length
    : 0;
  const minusMean = deltasMinus.length > 0
    ? deltasMinus.reduce((a, b) => a + b, 0) / deltasMinus.length
    : 0;

  const plusOne: PerturbationResult = {
    direction: '+1',
    originalGear: original.shadowGear,
    perturbedGear: plusResult.shadowGear,
    gearChanged: original.shadowGear !== plusResult.shadowGear,
    originalMean,
    perturbedMean: plusMean,
  };

  const minusOne: PerturbationResult = {
    direction: '-1',
    originalGear: original.shadowGear,
    perturbedGear: minusResult.shadowGear,
    gearChanged: original.shadowGear !== minusResult.shadowGear,
    originalMean,
    perturbedMean: minusMean,
  };

  return {
    timestamp: Date.now(),
    category,
    plusOne,
    minusOne,
    sensitive: plusOne.gearChanged || minusOne.gearChanged,
  };
}
