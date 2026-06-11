/**
 * Tests for ThresholdAuditor — delta update + cumulative clamp.
 * @see Plan36a §7 (C5), D3-R3
 */
import { describe, it, expect } from "vitest";
import { createThresholdAuditor, DEFAULT_THRESHOLD_RULES } from "../src/threshold-auditor.js";
import type { RouteResult } from "@openstarry/sdk";

function makeRouteResult(riskCategory: string, gear = 1): RouteResult {
  return {
    gear,
    threshold: 0.5,
    confidence: 0.8,
    reasoning: 'test',
    arbiterId: 'test-arbiter',
    riskCategory: riskCategory as any,
  } as RouteResult;
}

describe("ThresholdAuditor — delta values (C5)", () => {
  it("informational delta = +0.001", () => {
    const auditor = createThresholdAuditor();
    const result = auditor.audit(makeRouteResult('informational'));
    expect(result.delta).toBe(0.001);
  });

  it("read_only delta = +0.0005", () => {
    const auditor = createThresholdAuditor();
    const result = auditor.audit(makeRouteResult('read_only'));
    expect(result.delta).toBe(0.0005);
  });

  it("state_modifying delta = -0.01 (unchanged)", () => {
    const auditor = createThresholdAuditor();
    const result = auditor.audit(makeRouteResult('state_modifying'));
    expect(result.delta).toBe(-0.01);
  });

  it("destructive delta = -0.03 (unchanged)", () => {
    const auditor = createThresholdAuditor();
    const result = auditor.audit(makeRouteResult('destructive'));
    expect(result.delta).toBe(-0.03);
  });
});

describe("ThresholdAuditor — cumulative positive clamp (D3-R3)", () => {
  it("clamps cumulative positive at +0.05", () => {
    const auditor = createThresholdAuditor();
    let cumulative = 0;

    // 200 informational reads at +0.001 = +0.2, but clamped at +0.05
    for (let i = 0; i < 200; i++) {
      const result = auditor.audit(makeRouteResult('informational'));
      cumulative += result.delta;
    }

    // Should be clamped at 0.05, not 0.2
    expect(cumulative).toBeCloseTo(0.05, 5);
  });

  it("stops producing positive delta after clamp reached", () => {
    const auditor = createThresholdAuditor();

    // Exhaust the clamp (50 informational at +0.001 = exactly 0.05)
    for (let i = 0; i < 50; i++) {
      auditor.audit(makeRouteResult('informational'));
    }

    // Next call should produce delta = 0
    const result = auditor.audit(makeRouteResult('informational'));
    expect(result.delta).toBe(0);
    expect(result.reasoning).toContain('clamped');
  });

  it("negative deltas still work after positive clamp", () => {
    const auditor = createThresholdAuditor();

    // Exhaust positive clamp
    for (let i = 0; i < 150; i++) {
      auditor.audit(makeRouteResult('informational'));
    }

    // Destructive should still produce negative delta
    const result = auditor.audit(makeRouteResult('destructive'));
    expect(result.delta).toBe(-0.03);
  });

  it("per-session: new auditor instance resets clamp", () => {
    const auditor1 = createThresholdAuditor();

    // Exhaust clamp on auditor1
    for (let i = 0; i < 150; i++) {
      auditor1.audit(makeRouteResult('informational'));
    }
    expect(auditor1.audit(makeRouteResult('informational')).delta).toBe(0);

    // New instance = new session
    const auditor2 = createThresholdAuditor();
    expect(auditor2.audit(makeRouteResult('informational')).delta).toBe(0.001);
  });
});

describe("ThresholdAuditor — cumulative negative clamp (D1-R3)", () => {
  it("clamps cumulative negative at -0.05", () => {
    const auditor = createThresholdAuditor();
    let cumulative = 0;

    // 100 destructive at -0.03 = -3.0, but clamped at -0.05
    for (let i = 0; i < 100; i++) {
      const result = auditor.audit(makeRouteResult('destructive'));
      cumulative += result.delta;
    }

    expect(cumulative).toBeCloseTo(-0.05, 5);
  });

  it("stops producing negative delta after negative floor reached", () => {
    const auditor = createThresholdAuditor();

    // Exhaust the negative clamp
    for (let i = 0; i < 100; i++) {
      auditor.audit(makeRouteResult('destructive'));
    }

    // Next call should produce delta = 0
    const result = auditor.audit(makeRouteResult('destructive'));
    expect(result.delta).toBe(0);
    expect(result.reasoning).toContain('clamped');
  });

  it("positive deltas still work after negative floor reached", () => {
    const auditor = createThresholdAuditor();

    // Exhaust negative clamp
    for (let i = 0; i < 100; i++) {
      auditor.audit(makeRouteResult('destructive'));
    }

    // Informational should still produce positive delta (positive budget not exhausted)
    const result = auditor.audit(makeRouteResult('informational'));
    expect(result.delta).toBe(0.001);
  });
});

describe("ThresholdAuditor — DEFAULT_THRESHOLD_RULES", () => {
  it("has correct default rule values", () => {
    expect(DEFAULT_THRESHOLD_RULES).toEqual([
      { riskCategory: 'destructive', delta: -0.03, reasoning: expect.any(String) },
      { riskCategory: 'state_modifying', delta: -0.01, reasoning: expect.any(String) },
      { riskCategory: 'read_only', delta: 0.0005, reasoning: expect.any(String) },
      { riskCategory: 'informational', delta: 0.001, reasoning: expect.any(String) },
    ]);
  });
});
