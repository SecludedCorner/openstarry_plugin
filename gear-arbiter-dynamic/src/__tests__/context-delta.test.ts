/**
 * context-delta.test.ts — Unit tests for createContextDeltaProvider().
 * (Plan45 W2-2)
 */

import { describe, it, expect } from 'vitest';
import {
  createContextDeltaProvider,
  DEFAULT_CATEGORY_FACTORS,
} from '../context-delta-provider.js';
import { DELTA_SCALING_FACTOR } from '../calibration-bridge.js';

// ─── AC-W2-2a: enabled=false → identity (delta unchanged) ────────────────────

describe('createContextDeltaProvider - identity when disabled (AC-W2-2a)', () => {
  it('returns original delta when enabled=false (default)', () => {
    const provider = createContextDeltaProvider({ enabled: false });
    expect(provider('read_only', 0.055)).toBe(0.055);
    expect(provider('destructive', -0.01)).toBe(-0.01);
    expect(provider('informational', 0.0)).toBe(0.0);
    expect(provider('state_modifying', 0.1)).toBe(0.1);
  });

  it('returns original delta when enabled is omitted (defaults to false)', () => {
    const provider = createContextDeltaProvider({});
    expect(provider('read_only', 0.055)).toBe(0.055);
    expect(provider('unknown_category', 99)).toBe(99);
  });

  it('identity function is returned for any category when disabled', () => {
    const provider = createContextDeltaProvider({ enabled: false });
    const delta = 0.123456;
    expect(provider('anything', delta)).toBe(delta);
  });
});

// ─── AC-W2-2b: categoryFactor override → additive correction applied ──────────

describe('createContextDeltaProvider - additive correction for overridden category (AC-W2-2b)', () => {
  it('applies additive correction: corrected = base + (factor - DELTA_SCALING_FACTOR)', () => {
    const factor = 0.03;  // DELTA_SCALING_FACTOR = 0.055
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { destructive: factor },
    });
    // For a positive base delta: corrected = 0.055 + (0.03 - 0.055) = 0.03
    const base = 0.055;
    const expected = base + (factor - DELTA_SCALING_FACTOR);
    expect(provider('destructive', base)).toBeCloseTo(expected, 10);
  });

  it('higher factor → larger corrected delta', () => {
    const factor = 0.08;
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { informational: factor },
    });
    const base = 0.04;
    const expected = base + (factor - DELTA_SCALING_FACTOR);
    expect(provider('informational', base)).toBeCloseTo(expected, 10);
  });

  it('factor = DELTA_SCALING_FACTOR → no correction (identity for that category)', () => {
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { read_only: DELTA_SCALING_FACTOR },
    });
    const base = 0.07;
    expect(provider('read_only', base)).toBeCloseTo(base, 10);
  });

  it('DEFAULT_CATEGORY_FACTORS values all equal DELTA_SCALING_FACTOR (HYPOTHESIS baseline)', () => {
    for (const [, factor] of Object.entries(DEFAULT_CATEGORY_FACTORS)) {
      expect(factor).toBe(DELTA_SCALING_FACTOR);
    }
  });
});

// ─── AC-W2-2c: unknown category uses defaultFactor ───────────────────────────

describe('createContextDeltaProvider - defaultFactor for unlisted category (AC-W2-2c)', () => {
  it('uses defaultFactor when category not in categoryFactors', () => {
    const defaultFactor = 0.07;
    const provider = createContextDeltaProvider({
      enabled: true,
      defaultFactor,
    });
    const base = 0.04;
    const expected = base + (defaultFactor - DELTA_SCALING_FACTOR);
    expect(provider('unknown_category', base)).toBeCloseTo(expected, 10);
  });

  it('uses DELTA_SCALING_FACTOR (identity) when defaultFactor is omitted', () => {
    const provider = createContextDeltaProvider({
      enabled: true,
      // no categoryFactors, no defaultFactor → uses DELTA_SCALING_FACTOR
    });
    const base = 0.04;
    // correction = base + (DELTA_SCALING_FACTOR - DELTA_SCALING_FACTOR) = base
    expect(provider('unlisted', base)).toBeCloseTo(base, 10);
  });

  it('categoryFactors lookup takes precedence over defaultFactor', () => {
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { read_only: 0.03 },
      defaultFactor: 0.08,
    });
    const base = 0.055;
    // read_only: uses 0.03
    const expectedReadOnly = base + (0.03 - DELTA_SCALING_FACTOR);
    expect(provider('read_only', base)).toBeCloseTo(expectedReadOnly, 10);
    // informational: uses defaultFactor=0.08
    const expectedInformational = base + (0.08 - DELTA_SCALING_FACTOR);
    expect(provider('informational', base)).toBeCloseTo(expectedInformational, 10);
  });
});

// ─── AC-W2-2d: Rule #55 — destructive delta <= 0 invariant preserved ──────────

describe('createContextDeltaProvider - Rule #55 destructive delta guard (AC-W2-2d)', () => {
  it('negative delta stays negative: correction does not flip sign to positive', () => {
    // baseDelta = -0.01 (destructive/negative)
    // factor = 0.20 → correction = -0.01 + (0.20 - 0.055) = -0.01 + 0.145 = 0.135 > 0
    // → Rule #55 guard: return baseDelta = -0.01 (unchanged)
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { destructive: 0.20 },
    });
    const result = provider('destructive', -0.01);
    expect(result).toBe(-0.01);
    expect(result).toBeLessThan(0);
  });

  it('negative delta with small upward correction that keeps delta negative: allowed', () => {
    // baseDelta = -0.10, factor = 0.07
    // correction = -0.10 + (0.07 - 0.055) = -0.10 + 0.015 = -0.085 (still negative)
    // → guard should NOT block this (still <= 0)
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { destructive: 0.07 },
    });
    const result = provider('destructive', -0.10);
    expect(result).toBeCloseTo(-0.085, 10);
    expect(result).toBeLessThan(0);
  });

  it('zero delta: correction may produce non-zero, but zero is still safe', () => {
    // baseDelta = 0.0, factor = 0.03
    // correction = 0.0 + (0.03 - 0.055) = -0.025 (negative is fine)
    // baseDelta=0 is NOT < 0 so guard does not trigger
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { destructive: 0.03 },
    });
    const result = provider('destructive', 0.0);
    // 0 is not negative, so guard doesn't apply; correction proceeds
    expect(result).toBeCloseTo(-0.025, 10);
  });

  it('Rule #55 guard is category-agnostic: applies to any negative delta', () => {
    // Even for informational category, if baseDelta is negative, guard protects it
    const provider = createContextDeltaProvider({
      enabled: true,
      categoryFactors: { informational: 0.99 },
    });
    const result = provider('informational', -0.001);
    expect(result).toBe(-0.001);
    expect(result).toBeLessThan(0);
  });
});
