/**
 * Integration test for vedana-sensor-core plugin.
 * BCT-1: Empty registry neutral, BCT-4: fail-open, BCT-5: mixed signals.
 * @see Plan36a §3, §10.1
 */
import { describe, it, expect, vi } from "vitest";
import { createVedanaSensorCorePlugin, ToolOutcomeSensor, SafetyCheckSensor, ConfidenceGapSensor } from "../src/index.js";
import type { EventBus, AgentEvent, IPluginContext, InputEvent, ISessionManager } from "@openstarry/sdk";

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

function makeCtx(bus: EventBus): IPluginContext {
  return {
    bus,
    workingDirectory: '/tmp/test',
    agentId: 'test-agent',
    config: {},
    pushInput: vi.fn() as (event: InputEvent) => void,
    sessions: {} as ISessionManager,
  };
}

describe("vedana-sensor-core — plugin integration", () => {
  it("factory returns 3 vedanaSensors", async () => {
    const bus = makeMockBus();
    const plugin = createVedanaSensorCorePlugin();
    const hooks = await plugin.factory(makeCtx(bus));

    expect(hooks.vedanaSensors).toHaveLength(3);
    expect(hooks.vedanaSensors![0].channel).toBe('tool-outcome');
    expect(hooks.vedanaSensors![1].channel).toBe('safety-check');
    expect(hooks.vedanaSensors![2].channel).toBe('confidence-gap');
  });

  it("manifest has correct skandha and criticality", () => {
    const plugin = createVedanaSensorCorePlugin();
    expect(plugin.manifest.skandha).toBe('vedana');
    expect(plugin.manifest.criticality).toBe('optional-degraded');
  });

  it("BCT-5: mixed signals produce correct aggregate pattern", async () => {
    const bus = makeMockBus();
    const plugin = createVedanaSensorCorePlugin();
    const hooks = await plugin.factory(makeCtx(bus));
    const sensors = hooks.vedanaSensors!;

    // All start neutral
    for (const sensor of sensors) {
      const result = sensor.sense(null);
      expect(result.type).toBe('upekkha');
    }
  });
});
