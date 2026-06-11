/**
 * Tests for ConfidenceGapSensor.
 * @see Plan36a §3.6
 */
import { describe, it, expect, vi } from "vitest";
import { ConfidenceGapSensor } from "../src/confidence-gap-sensor.js";
import type { EventBus, AgentEvent } from "@openstarry/sdk";

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
    trigger(type: string, payload?: unknown) {
      for (const h of handlers.get(type) ?? []) {
        h({ type, timestamp: Date.now(), payload });
      }
    },
  } as unknown as EventBus & { trigger: (type: string, payload?: unknown) => void };
}

describe("ConfidenceGapSensor", () => {
  it("returns upekkha with no events", () => {
    const sensor = new ConfidenceGapSensor('test-1');
    const result = sensor.sense(null);
    expect(result.type).toBe('upekkha');
    expect(result.source).toBe('confidence-gap');
  });

  it("returns dukkha (vimati) when gap < anxietyThreshold", () => {
    const bus = makeMockBus();
    const sensor = new ConfidenceGapSensor('test-1', {}, bus);

    // Gap = 0.55 - 0.50 = 0.05 < 0.1 (anxiety threshold)
    bus.trigger('gear:arbiter_evaluated', { confidence: 0.55, threshold: 0.50 });
    const result = sensor.sense(null);

    expect(result.valence).toBeLessThan(0);
    expect(result.type).toBe('dukkha');
  });

  it("returns sukha (prasada) when gap > comfortThreshold", () => {
    const bus = makeMockBus();
    const sensor = new ConfidenceGapSensor('test-1', {}, bus);

    // Gap = 0.90 - 0.50 = 0.40 > 0.3 (comfort threshold)
    bus.trigger('gear:arbiter_evaluated', { confidence: 0.90, threshold: 0.50 });
    const result = sensor.sense(null);

    expect(result.valence).toBeGreaterThan(0);
    expect(result.type).toBe('sukha');
  });

  it("returns upekkha in middle zone", () => {
    const bus = makeMockBus();
    const sensor = new ConfidenceGapSensor('test-1', {}, bus);

    // Gap = 0.70 - 0.50 = 0.20, between 0.1 and 0.3
    bus.trigger('gear:arbiter_evaluated', { confidence: 0.70, threshold: 0.50 });
    const result = sensor.sense(null);

    expect(result.type).toBe('upekkha');
  });

  it("resets on gear:switch", () => {
    const bus = makeMockBus();
    const sensor = new ConfidenceGapSensor('test-1', {}, bus);

    bus.trigger('gear:arbiter_evaluated', { confidence: 0.55, threshold: 0.50 });
    expect(sensor.sense(null).type).toBe('dukkha');

    bus.trigger('gear:switch');
    const result = sensor.sense(null);
    expect(result.type).toBe('upekkha');
  });

  it("fail-open: returns neutral on error", () => {
    const sensor = new ConfidenceGapSensor('test-1');
    (sensor as any).lastGap = "invalid";
    const result = sensor.sense(null);
    expect(result.type).toBe('upekkha');
    expect(result.valence).toBe(0);
  });

  it("has correct skandha and channel", () => {
    const sensor = new ConfidenceGapSensor('test-1');
    expect(sensor.skandha).toBe('vedana');
    expect(sensor.channel).toBe('confidence-gap');
  });
});
