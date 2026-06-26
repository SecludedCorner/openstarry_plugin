/**
 * Tests for the default 4-dimensional loop-quality monitor. Shipped with zero
 * test coverage (v0.59.7 audit). Drives real loop cycles through a fake
 * EventBus and asserts warmup gating + the quality vector behavior.
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentEvent, EventHandler } from "@openstarry/sdk";
import { createDefaultLoopQualityMonitor } from "./default-loop-quality-monitor.js";

function makeBus() {
  const handlers = new Map<string, Set<EventHandler>>();
  const emitted: AgentEvent[] = [];
  const bus = {
    on(type: string, h: EventHandler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(h);
      return () => handlers.get(type)!.delete(h);
    },
    emit(e: AgentEvent) {
      emitted.push(e);
      for (const h of handlers.get(e.type) ?? []) h(e);
    },
  };
  return { bus, emitted, handlers };
}

/** Drive one full loop cycle. */
function cycle(
  bus: { emit: (e: AgentEvent) => void },
  opts: { switches?: number; proposed?: number; successes?: number } = {},
) {
  const { switches = 0, proposed = 1, successes = 1 } = opts;
  bus.emit({ type: "loop:started", timestamp: 1 } as AgentEvent);
  for (let i = 0; i < switches; i++) bus.emit({ type: "gear:switch", timestamp: 1 } as AgentEvent);
  for (let i = 0; i < proposed; i++) bus.emit({ type: "action:proposed", timestamp: 1 } as AgentEvent);
  for (let i = 0; i < successes; i++)
    bus.emit({ type: "tool:result", timestamp: 1, payload: { result: "ok" } } as AgentEvent);
  bus.emit({ type: "loop:finished", timestamp: 1 } as AgentEvent);
}

describe("default loop-quality monitor", () => {
  it("returns null until warmup (5 cycles) is reached", () => {
    const { bus } = makeBus();
    const m = createDefaultLoopQualityMonitor();
    m.start(bus as never);
    for (let i = 0; i < 4; i++) cycle(bus);
    expect(m.getReport()).toBeNull();
    cycle(bus); // 5th
    expect(m.getReport()).not.toBeNull();
  });

  it("a perfect run (no switches, all successes) scores near 1", () => {
    const { bus } = makeBus();
    const m = createDefaultLoopQualityMonitor();
    m.start(bus as never);
    for (let i = 0; i < 6; i++) cycle(bus, { switches: 0, proposed: 1, successes: 1 });
    const r = m.getReport()!;
    expect(r.vector.coherence).toBe(1);
    expect(r.vector.efficiency).toBe(1);
    expect(r.vector.convergence).toBe(1);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it("frequent gear switches lower coherence below a clean run", () => {
    const clean = (() => {
      const { bus } = makeBus();
      const m = createDefaultLoopQualityMonitor();
      m.start(bus as never);
      for (let i = 0; i < 6; i++) cycle(bus, { switches: 0 });
      return m.getReport()!;
    })();

    const churny = (() => {
      const { bus } = makeBus();
      const m = createDefaultLoopQualityMonitor();
      m.start(bus as never);
      for (let i = 0; i < 6; i++) cycle(bus, { switches: 3 });
      return m.getReport()!;
    })();

    expect(churny.vector.coherence).toBeLessThan(clean.vector.coherence);
    expect(churny.score).toBeLessThan(clean.score);
  });

  it("emits loop:quality_updated once warmed up", () => {
    const { bus, emitted } = makeBus();
    const m = createDefaultLoopQualityMonitor();
    m.start(bus as never);
    for (let i = 0; i < 6; i++) cycle(bus);
    expect(emitted.some((e) => e.type === "loop:quality_updated")).toBe(true);
  });

  it("stop() unsubscribes — further cycles do not update the report", () => {
    const { bus } = makeBus();
    const m = createDefaultLoopQualityMonitor();
    m.start(bus as never);
    for (let i = 0; i < 6; i++) cycle(bus, { switches: 0 });
    const before = m.getReport()!.score;
    m.stop();
    for (let i = 0; i < 6; i++) cycle(bus, { switches: 5 }); // would worsen if still subscribed
    expect(m.getReport()!.score).toBe(before);
  });

  it("respects a custom warmup count", () => {
    const { bus } = makeBus();
    const m = createDefaultLoopQualityMonitor({ warmupCount: 2 });
    m.start(bus as never);
    cycle(bus);
    expect(m.getReport()).toBeNull();
    cycle(bus);
    expect(m.getReport()).not.toBeNull();
  });
});
