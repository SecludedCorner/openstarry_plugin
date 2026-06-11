/**
 * Tests for SafetyCheckSensor.
 * @see Plan36a §3.5, D4-R8 (VedanaEmergency interaction)
 */
import { describe, it, expect, vi } from "vitest";
import { SafetyCheckSensor } from "../src/safety-check-sensor.js";
import type { EventBus, AgentEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

function makeMockBus() {
  const handlers = new Map<string, Array<(event: AgentEvent) => void>>();
  return {
    emit: vi.fn(),
    on: vi.fn((type: string, handler: (event: AgentEvent) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
      return () => {};
    }),
    once: vi.fn(),
    onAny: vi.fn(),
    trigger(type: string) {
      for (const h of handlers.get(type) ?? []) {
        h({ type, timestamp: Date.now(), payload: {} });
      }
    },
  } as unknown as EventBus & { trigger: (type: string) => void };
}

describe("SafetyCheckSensor", () => {
  it("returns neutral vedana with no events", () => {
    const sensor = new SafetyCheckSensor('test-1');
    const result = sensor.sense(null);
    expect(result.valence).toBe(0);
    expect(result.intensity).toBe(0);
    expect(result.type).toBe('upekkha');
  });

  it("returns dukkha on safety warning", () => {
    const bus = makeMockBus();
    const sensor = new SafetyCheckSensor('test-1', {}, bus);

    bus.trigger(AgentEventType.SAFETY_WARNING);
    const result = sensor.sense(null);

    expect(result.valence).toBeLessThan(0);
    expect(result.type).toBe('dukkha');
  });

  it("returns maximum alarm on safety lockout", () => {
    const bus = makeMockBus();
    const sensor = new SafetyCheckSensor('test-1', {}, bus);

    bus.trigger(AgentEventType.SAFETY_LOCKOUT);
    const result = sensor.sense(null);

    expect(result.valence).toBeCloseTo(-0.9, 1);
    expect(result.intensity).toBeCloseTo(1.0, 1);
  });

  it("D4-R8: warning intensity (0.6) < VedanaEmergency threshold (0.8)", () => {
    const bus = makeMockBus();
    const sensor = new SafetyCheckSensor('test-1', {}, bus);

    bus.trigger(AgentEventType.SAFETY_WARNING);
    const result = sensor.sense(null);

    // CRITICAL: warning intensity must be < 0.8 (VedanaEmergency intensityThreshold)
    expect(result.intensity).toBeLessThan(0.8);
    expect(result.intensity).toBeCloseTo(0.6, 1);
  });

  it("intensity decays over time", () => {
    const bus = makeMockBus();
    const sensor = new SafetyCheckSensor('test-1', { decayHalfLifeMs: 100 }, bus);

    bus.trigger(AgentEventType.SAFETY_WARNING);

    // Immediately after
    const immediate = sensor.sense(null);
    expect(immediate.intensity).toBeGreaterThan(0.5);

    // Fast-forward time
    (sensor as any).lastEventTime = Date.now() - 500; // 5 half-lives

    const decayed = sensor.sense(null);
    expect(decayed.intensity).toBeLessThan(0.1);
  });

  it("fail-open: returns neutral on error", () => {
    const sensor = new SafetyCheckSensor('test-1');
    (sensor as any).lastEventTime = "invalid";
    const result = sensor.sense(null);
    expect(result.type).toBe('upekkha');
  });

  it("has correct skandha and channel", () => {
    const sensor = new SafetyCheckSensor('test-1');
    expect(sensor.skandha).toBe('vedana');
    expect(sensor.channel).toBe('safety-check');
  });
});
