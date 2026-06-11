/**
 * perturbation-diagnostic.test.ts — Unit tests for computePerturbationDiagnostic().
 * (Plan45 W2-1)
 */

import { describe, it, expect } from 'vitest';
import { computePerturbationDiagnostic } from '../perturbation-diagnostic.js';

// WIENER constants (mirrored for test setup)
const UP = 0.047;
const DOWN = 0.031;
const MIN_N = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a deltas array of `n` uniform values. */
function uniformDeltas(value: number, n: number): number[] {
  return Array.from({ length: n }, () => value);
}

// ─── AC-W2-1a: pure function — deterministic, no side effects ─────────────────

describe('computePerturbationDiagnostic - pure function (AC-W2-1a)', () => {
  it('returns equal output for equal inputs (deterministic)', () => {
    const deltas = uniformDeltas(0.04, 15);
    const totalObs = 20;
    const gear = 1;
    const dwell = 3;
    const category = 'read_only';

    const r1 = computePerturbationDiagnostic(deltas, totalObs, gear, dwell, category);
    const r2 = computePerturbationDiagnostic(deltas, totalObs, gear, dwell, category);

    // All structural fields except timestamp must be equal
    expect(r1.category).toBe(r2.category);
    expect(r1.sensitive).toBe(r2.sensitive);
    expect(r1.plusOne.gearChanged).toBe(r2.plusOne.gearChanged);
    expect(r1.plusOne.perturbedGear).toBe(r2.plusOne.perturbedGear);
    expect(r1.minusOne.gearChanged).toBe(r2.minusOne.gearChanged);
    expect(r1.minusOne.perturbedGear).toBe(r2.minusOne.perturbedGear);
    expect(r1.plusOne.originalMean).toBe(r2.plusOne.originalMean);
    expect(r1.plusOne.perturbedMean).toBe(r2.plusOne.perturbedMean);
  });

  it('does not mutate the input deltas array', () => {
    const deltas = uniformDeltas(0.04, 12);
    const original = [...deltas];
    computePerturbationDiagnostic(deltas, 15, 1, 3, 'informational');
    expect(deltas).toEqual(original);
  });

  it('category label is preserved in output', () => {
    const result = computePerturbationDiagnostic(uniformDeltas(0.0, 12), 15, 1, 0, 'destructive');
    expect(result.category).toBe('destructive');
  });
});

// ─── AC-W2-1b: +1 / -1 shifts only the last delta ────────────────────────────

describe('computePerturbationDiagnostic - shifts only last delta (AC-W2-1b)', () => {
  it('perturbedMean reflects shift of last element for +1', () => {
    // deltas = [0.04, 0.04, 0.04] — 3 elements, mean = 0.04
    // +1 perturbation shifts last: [0.04, 0.04, 1.04] — mean = (0.04+0.04+1.04)/3
    const deltas = [0.04, 0.04, 0.04];
    const result = computePerturbationDiagnostic(deltas, 15, 1, 5, 'read_only');

    const expectedPlusMean = (0.04 + 0.04 + 1.04) / 3;
    expect(result.plusOne.perturbedMean).toBeCloseTo(expectedPlusMean, 10);
  });

  it('perturbedMean reflects shift of last element for -1', () => {
    // deltas = [0.04, 0.04, 0.04]
    // -1 perturbation shifts last: [0.04, 0.04, -0.96] — mean = (0.04+0.04-0.96)/3
    const deltas = [0.04, 0.04, 0.04];
    const result = computePerturbationDiagnostic(deltas, 15, 1, 5, 'read_only');

    const expectedMinusMean = (0.04 + 0.04 + -0.96) / 3;
    expect(result.minusOne.perturbedMean).toBeCloseTo(expectedMinusMean, 10);
  });

  it('originalMean is unaffected (same as arithmetic mean of input deltas)', () => {
    const deltas = [0.03, 0.05, 0.06];
    const expectedMean = (0.03 + 0.05 + 0.06) / 3;
    const result = computePerturbationDiagnostic(deltas, 15, 1, 5, 'read_only');
    expect(result.plusOne.originalMean).toBeCloseTo(expectedMean, 10);
    expect(result.minusOne.originalMean).toBeCloseTo(expectedMean, 10);
  });
});

// ─── AC-W2-1c: sensitive=false when no gear changes ──────────────────────────

describe('computePerturbationDiagnostic - sensitive=false when gears unchanged (AC-W2-1c)', () => {
  it('sensitive=false when all three shadow gears are the same', () => {
    // Well below threshold: mean = 0.00 → gear stays 1 for all perturbations
    // Single delta: perturbed deltas will be [1.0] and [-1.0]
    // but totalObs < MIN_N → computeShadowDecision abstains (returns {shadowGear:gear, abstains:true})
    // so all three return gear=1 → no change → sensitive=false
    const deltas = [0.0];
    const result = computePerturbationDiagnostic(deltas, 5, 1, 0, 'informational');
    // abstains because totalObs < MIN_N, all return gear=1
    expect(result.sensitive).toBe(false);
    expect(result.plusOne.gearChanged).toBe(false);
    expect(result.minusOne.gearChanged).toBe(false);
  });

  it('sensitive=false with many observations well away from threshold', () => {
    // Use a large array so that +1 on the last element barely moves the mean.
    // 100 deltas at 0.0 → mean = 0.0. After +1 on last: mean = 1/100 = 0.01, still < UP=0.047.
    // dwell=5 >= MIN_DWELL, totalObs=120 > MIN_N, gear=1 → shadow logic: mean < UP → no change.
    const deltas = uniformDeltas(0.0, 100);
    const result = computePerturbationDiagnostic(deltas, 120, 1, 5, 'read_only');
    // mean+1 = 0.01 < UP=0.047 → still gear=1, no change
    expect(result.sensitive).toBe(false);
  });

  it('direction fields are correct even when not sensitive', () => {
    const deltas = uniformDeltas(0.0, 15);
    const result = computePerturbationDiagnostic(deltas, 20, 1, 5, 'read_only');
    expect(result.plusOne.direction).toBe('+1');
    expect(result.minusOne.direction).toBe('-1');
  });
});

// ─── AC-W2-1d: sensitive=true + correct gearChanged when gear changes ─────────

describe('computePerturbationDiagnostic - sensitive=true when gear changes (AC-W2-1d)', () => {
  it('sensitive=true when +1 causes gear to change', () => {
    // Gear=1, mean just BELOW UP=0.047. +1 on last element pushes mean above UP.
    // dwell=5 >= MIN_DWELL so the switch condition fires.
    //
    // Strategy: use a large array so that the original mean is below UP,
    // but the +1 shift on the last element pushes mean above UP.
    //
    // 100 deltas at 0.04 → mean = 0.04 < UP=0.047 → original stays gear=1.
    // After +1 on last: mean = (99*0.04 + 1.04)/100 = (3.96+1.04)/100 = 5.0/100 = 0.05 > 0.047 ✓
    const deltas = uniformDeltas(0.04, 100);
    const result = computePerturbationDiagnostic(deltas, 120, 1, 5, 'read_only');

    expect(result.plusOne.gearChanged).toBe(true);
    expect(result.plusOne.originalGear).toBe(1);
    expect(result.plusOne.perturbedGear).toBe(2);
    expect(result.sensitive).toBe(true);
  });

  it('sensitive=true when -1 causes gear to change', () => {
    // Gear=2, mean just ABOVE DOWN=0.031. -1 on last element pushes mean below DOWN.
    // dwell=5 >= MIN_DWELL.
    //
    // 100 deltas at 0.035 → mean = 0.035 > DOWN=0.031 → original stays gear=2.
    // After -1 on last: mean = (99*0.035 + -0.965)/100 = (3.465-0.965)/100 = 2.5/100 = 0.025 < 0.031 ✓
    const deltas = uniformDeltas(0.035, 100);
    const result = computePerturbationDiagnostic(deltas, 120, 2, 5, 'read_only');

    expect(result.minusOne.gearChanged).toBe(true);
    expect(result.minusOne.originalGear).toBe(2);
    expect(result.minusOne.perturbedGear).toBe(1);
    expect(result.sensitive).toBe(true);
  });
});

// ─── Bonus: empty deltas array handled without throwing ──────────────────────

describe('computePerturbationDiagnostic - empty deltas edge case', () => {
  it('handles empty deltas without throwing', () => {
    expect(() =>
      computePerturbationDiagnostic([], 0, 1, 0, 'informational'),
    ).not.toThrow();
  });

  it('returns originalMean=0 and perturbedMean=0 for empty deltas', () => {
    const result = computePerturbationDiagnostic([], 0, 1, 0, 'informational');
    expect(result.plusOne.originalMean).toBe(0);
    expect(result.plusOne.perturbedMean).toBe(0);
    expect(result.minusOne.originalMean).toBe(0);
    expect(result.minusOne.perturbedMean).toBe(0);
  });

  it('sensitive=false for empty deltas (all abstain → same gear)', () => {
    const result = computePerturbationDiagnostic([], 0, 1, 0, 'informational');
    expect(result.sensitive).toBe(false);
  });

  it('has correct direction labels for empty deltas', () => {
    const result = computePerturbationDiagnostic([], 5, 1, 0, 'read_only');
    expect(result.plusOne.direction).toBe('+1');
    expect(result.minusOne.direction).toBe('-1');
  });
});
