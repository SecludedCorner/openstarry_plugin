/**
 * Tests for the passthrough (delta=0) confidence auditor — the reference
 * IConfidenceAuditor. Shipped with zero test coverage (v0.59.7 audit).
 */

import { describe, it, expect } from "vitest";
import { createPassthroughAuditor } from "./passthrough-auditor.js";

describe("passthrough auditor", () => {
  it("defaults its id and exposes vijnana skandha", () => {
    const a = createPassthroughAuditor();
    expect(a.id).toBe("passthrough-auditor");
    expect(a.skandha).toBe("vijnana");
  });

  it("honors a custom id", () => {
    expect(createPassthroughAuditor("my-auditor").id).toBe("my-auditor");
  });

  it("always returns delta 0 (the passthrough contract)", () => {
    const a = createPassthroughAuditor();
    const r = a.audit({ gear: 1, confidence: 0.9 } as never);
    expect(r.delta).toBe(0);
    expect(typeof r.reasoning).toBe("string");
  });

  it("accepts a bare RouteResult and reflects its gear/confidence in reasoning", () => {
    const a = createPassthroughAuditor();
    const r = a.audit({ gear: 2, confidence: 0.42 } as never);
    expect(r.delta).toBe(0);
    expect(r.reasoning).toContain("gear=2");
    expect(r.reasoning).toContain("confidence=0.42");
  });

  it("accepts an AuditContext (unwraps .routeResult)", () => {
    const a = createPassthroughAuditor();
    const r = a.audit({ routeResult: { gear: 3, confidence: 0.7 } } as never);
    expect(r.delta).toBe(0);
    expect(r.reasoning).toContain("gear=3");
  });

  it("coerces non-finite gear/confidence to 0 in reasoning", () => {
    const a = createPassthroughAuditor();
    const r = a.audit({ gear: NaN, confidence: undefined } as never);
    expect(r.delta).toBe(0);
    expect(r.reasoning).toContain("gear=0");
    expect(r.reasoning).toContain("confidence=0");
  });
});
