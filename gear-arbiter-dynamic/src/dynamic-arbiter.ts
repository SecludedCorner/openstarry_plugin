/** dynamic-arbiter — WIENER control theory gear arbiter. Priority 20 > static 10. [C41-12] */

import type { IGearArbiter, GearContext, GearEvaluation } from '@openstarry/sdk';
import type { StateTracker } from './state-tracker.js';

// WIENER constants (C-W-CV5-1/2/3) — using Spec's rounded thresholds
// to ensure hysteresis gap >= 0.016 (UP - DOWN = 0.047 - 0.031 = 0.016)
const UP   = 0.047;  // switch to gear 2 (>= 1.5 * sigma, C-W-CV5-1)
const DOWN = 0.031;  // switch back to gear 1 (hysteresis band = 0.016, C-W-CV5-2)
const MIN_DWELL = 5; // C-W-CV5-3
const MIN_N = 10;    // KNUTH C-K-CV5-1 (AC-CV5-6)

/** Audit callback for gear state transitions (AC-CV5-10). */
export type GearTransitionCallback = (payload: object) => void;

/** Phase 3 configuration placeholder (Plan44 scope). */
export interface Phase3Config {
  readonly enabled: boolean;
}

/** Options for DynamicArbiter constructor (COND-3, Plan43). */
export interface DynamicArbiterOptions {
  readonly stateTracker: StateTracker;
  readonly onTransition?: GearTransitionCallback;
  readonly initialGear?: number;
  // Phase3Config activation deferred to Plan44 (C43-3)
  readonly phase3Config?: Phase3Config;
}

export class DynamicArbiter implements IGearArbiter {
  readonly id = 'gear-arbiter-dynamic';
  readonly priority = 20; // C41-12

  private gear: number;
  private dwell = 0;

  /**
   * One-shot gear override for L3 Safety Gate response (Plan45 W1-3).
   * Null when no override is pending.
   * Conservative-only invariant: only gear <= currentGear is accepted.
   */
  private forcedNextGear: number | null = null;

  constructor(private readonly options: DynamicArbiterOptions) {
    this.gear = options.initialGear ?? 1;
  }

  /** Read-only state accessor for shadow computation (Plan44 W1). C44-2: NOT used in evaluate(). */
  getState(): { readonly gear: number; readonly dwell: number } {
    return { gear: this.gear, dwell: this.dwell };
  }

  /**
   * One-shot gear override for L3 Safety Gate response.
   * Mirrors ManoAggregator.forceNextGear() pattern (Plan27b precedent).
   *
   * Constraints:
   *   - gear MUST be <= current gear (conservative-only, D9-Q29, C45-5)
   *   - override is consumed on the NEXT evaluate() call only (one-shot)
   *   - if gear > current gear: silently no-op (not an error)
   *
   * MUST NOT be called from Core (Tenet #7).
   * Independent implementation — does NOT import Core ManoAggregator.
   */
  forceNextGear(gear: number): void {
    // Conservative-only invariant: only accept gear <= currentGear
    if (gear <= this.gear) {
      this.forcedNextGear = gear;
    }
    // else: silently no-op (D9-Q29)
  }

  evaluate(context: GearContext): GearEvaluation {
    void context;
    const deltas = this.options.stateTracker.getRecentDeltas();

    // AC-CV5-6: observe mode until n >= MIN_N (shadow counting via total observations)
    const totalObs = this.options.stateTracker.getTotalObservations();
    if (totalObs < MIN_N) {
      return { action: 'abstain', confidence: 0, reasoning: `Observe: ${totalObs}/${MIN_N} observations` };
    }

    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;

    // AC-CV5-9: destructive delta <= 0 (negatives must not be positive)
    const negMean = deltas.filter(d => d < 0).reduce((a, b, _, arr) => a + b / arr.length, 0);
    if (negMean > 0) {
      return { action: 'abstain', confidence: 0, riskCategory: 'destructive',
        reasoning: `Destructive delta constraint: negMean=${negMean.toFixed(4)}` };
    }

    const prev = this.gear;

    // Plan45 W1-3: consume one-shot L3 override (conservative-only invariant enforced in forceNextGear)
    if (this.forcedNextGear !== null) {
      this.gear = this.forcedNextGear;
      this.forcedNextGear = null;
      this.dwell = 0;

      if (prev !== this.gear && this.options.onTransition) {
        this.options.onTransition({
          currentGear: this.gear, prevGear: prev,
          recentDeltas: deltas.slice(-5), dwellCounter: this.dwell,
          switchReason: `L3 safety gate forced gear=${this.gear}`,
        });
      }

      return {
        action: this.gear,
        confidence: 1.0,
        reasoning: `L3 safety gate override: gear=${this.gear}`,
      };
    }

    // C-W-CV5-2/3: hysteresis + dwell
    if (this.gear === 1 && mean >= UP) {
      this.dwell = this.dwell >= MIN_DWELL ? (this.gear = 2, 0) : this.dwell + 1;
    } else if (this.gear === 2 && mean <= DOWN) {
      this.dwell = this.dwell >= MIN_DWELL ? (this.gear = 1, 0) : this.dwell + 1;
    } else {
      this.dwell = 0;
    }

    // AC-CV5-10: emit state transitions to audit trail via callback
    if (prev !== this.gear && this.options.onTransition) {
      this.options.onTransition({
        currentGear: this.gear, prevGear: prev,
        recentDeltas: deltas.slice(-5), dwellCounter: this.dwell,
        switchReason: `mean=${mean.toFixed(4)} crossed ${prev === 1 ? 'UP' : 'DOWN'} threshold`,
      });
    }

    return {
      action: this.gear,
      confidence: Math.min(0.85, 0.5 + Math.abs(mean - UP) * 10),
      reasoning: `WIENER gear=${this.gear} mean=${mean.toFixed(4)} dwell=${this.dwell}`,
    };
  }
}
