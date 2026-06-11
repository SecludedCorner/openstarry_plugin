/**
 * shadow-decision — pure function shadow computation for Phase 3 non-inferiority.
 * MUST NOT import ManoAggregator (C44-1).
 * NOT reachable from RouteResult path (AC-W1-2).
 * @see Plan44 W1-1
 */

// WIENER constants (duplicated from dynamic-arbiter for isolation, C44-1)
const UP = 0.047;
const DOWN = 0.031;
const MIN_DWELL = 5;
const MIN_N = 10;

/**
 * Compute what the dynamic arbiter WOULD decide given immutable state inputs.
 * Pure function: no `this`, no mutation, no side effects (AC-W1-1).
 */
export function computeShadowDecision(
  deltas: readonly number[],
  totalObs: number,
  gear: number,
  dwell: number,
): { readonly shadowGear: number; readonly abstains: boolean } {
  if (totalObs < MIN_N || deltas.length === 0) {
    return { shadowGear: gear, abstains: true };
  }

  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  // Destructive delta constraint (same logic as evaluate)
  const negatives = deltas.filter(d => d < 0);
  const negMean = negatives.length > 0
    ? negatives.reduce((a, b) => a + b, 0) / negatives.length
    : 0;
  if (negMean > 0) {
    return { shadowGear: gear, abstains: true };
  }

  let shadowGear = gear;
  if (gear === 1 && mean >= UP && dwell >= MIN_DWELL) {
    shadowGear = 2;
  } else if (gear === 2 && mean <= DOWN && dwell >= MIN_DWELL) {
    shadowGear = 1;
  }

  return { shadowGear, abstains: false };
}
