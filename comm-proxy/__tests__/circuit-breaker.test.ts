import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { CircuitBreakerError } from "@openstarry/sdk";

describe("L2 Circuit Breaker (Plan38 C10)", () => {
  it("starts in CLOSED state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState("target-1")).toBe("CLOSED");
  });

  it("remains CLOSED below failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("t");
    cb.recordFailure("t");
    expect(cb.getState("t")).toBe("CLOSED");
  });

  it("transitions CLOSED → OPEN at threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("t");
    cb.recordFailure("t");
    cb.recordFailure("t");
    expect(cb.getState("t")).toBe("OPEN");
  });

  it("throws CircuitBreakerError when OPEN", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("t");
    expect(() => cb.check("t")).toThrow(CircuitBreakerError);
  });

  it("transitions OPEN → HALF_OPEN after cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    cb.recordFailure("t");
    expect(cb.getState("t")).toBe("OPEN");

    // Advance time
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    cb.check("t"); // Should not throw, transitions to HALF_OPEN
    expect(cb.getState("t")).toBe("HALF_OPEN");
    vi.useRealTimers();
  });

  it("transitions HALF_OPEN → CLOSED on success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    cb.recordFailure("t");
    cb.check("t"); // OPEN → HALF_OPEN (cooldown=0)
    cb.recordSuccess("t");
    expect(cb.getState("t")).toBe("CLOSED");
  });

  it("transitions HALF_OPEN → OPEN on failure", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    cb.recordFailure("t");
    cb.check("t"); // OPEN → HALF_OPEN
    cb.recordFailure("t");
    expect(cb.getState("t")).toBe("OPEN");
  });

  it("sliding window expires old failures", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 3, monitorWindowMs: 1000 });
    cb.recordFailure("t");
    cb.recordFailure("t");
    vi.advanceTimersByTime(1100); // First two failures expire
    cb.recordFailure("t"); // Only 1 failure in window
    expect(cb.getState("t")).toBe("CLOSED");
    vi.useRealTimers();
  });
});
