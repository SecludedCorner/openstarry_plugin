/**
 * Tests for ToolOutcomeSensor.
 * @see Plan36a §3.4
 */
import { describe, it, expect, vi } from "vitest";
import { ToolOutcomeSensor } from "../src/tool-outcome-sensor.js";
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

describe("ToolOutcomeSensor", () => {
  it("returns neutral vedana when no events", () => {
    const sensor = new ToolOutcomeSensor('test-1');
    const result = sensor.sense(null);
    expect(result.valence).toBe(0);
    expect(result.intensity).toBe(0);
    expect(result.type).toBe('upekkha');
    expect(result.source).toBe('tool-outcome');
  });

  it("returns sukha after tool success", () => {
    const bus = makeMockBus();
    const sensor = new ToolOutcomeSensor('test-1', {}, bus);

    bus.trigger(AgentEventType.TOOL_RESULT);
    const result = sensor.sense(null);

    expect(result.valence).toBe(0.3);
    expect(result.type).toBe('sukha');
  });

  it("returns dukkha after tool error", () => {
    const bus = makeMockBus();
    const sensor = new ToolOutcomeSensor('test-1', {}, bus);

    bus.trigger(AgentEventType.TOOL_ERROR);
    const result = sensor.sense(null);

    expect(result.valence).toBe(-0.5);
    expect(result.type).toBe('dukkha');
  });

  it("maintains sliding window", () => {
    const bus = makeMockBus();
    const sensor = new ToolOutcomeSensor('test-1', { windowSize: 3 }, bus);

    // 3 successes
    bus.trigger(AgentEventType.TOOL_RESULT);
    bus.trigger(AgentEventType.TOOL_RESULT);
    bus.trigger(AgentEventType.TOOL_RESULT);

    let result = sensor.sense(null);
    expect(result.valence).toBeCloseTo(0.3);

    // Add 3 errors - window pushes out successes
    bus.trigger(AgentEventType.TOOL_ERROR);
    bus.trigger(AgentEventType.TOOL_ERROR);
    bus.trigger(AgentEventType.TOOL_ERROR);

    result = sensor.sense(null);
    expect(result.valence).toBeCloseTo(-0.5);
  });

  it("fail-open: returns neutral on error", () => {
    const sensor = new ToolOutcomeSensor('test-1');
    // Force internal state to be bad
    (sensor as any).window = null;
    const result = sensor.sense(null);
    expect(result.type).toBe('upekkha');
    expect(result.valence).toBe(0);
  });

  it("output bounds: valence clamped to [-1, 1]", () => {
    const sensor = new ToolOutcomeSensor('test-1', { errorValence: -2.0 });
    // Manually push an extreme entry
    (sensor as any).window.push({ valence: -2.0, intensity: 0.5 });
    const result = sensor.sense(null);
    expect(result.valence).toBeGreaterThanOrEqual(-1);
    expect(result.valence).toBeLessThanOrEqual(1);
  });

  it("has correct skandha and channel", () => {
    const sensor = new ToolOutcomeSensor('test-1');
    expect(sensor.skandha).toBe('vedana');
    expect(sensor.channel).toBe('tool-outcome');
  });
});
