import { describe, it, expect, beforeEach } from "vitest";
import { DevToolsPanel } from "../../src/ui/devtools-panel.js";
import { StateInspector, EventLog } from "../../src/state/inspector.js";
import { MetricsCollector } from "../../src/metrics/collector.js";
import type { MetricsSnapshot } from "../../src/types/state.js";

function createMockContext(): any {
  return {
    sessions: {
      list: () => [],
      getDefaultSession: () => null,
    },
    bus: { onAny: () => () => {}, emit: () => {} },
  };
}

describe("DevToolsPanel", () => {
  let panel: DevToolsPanel;
  let collector: MetricsCollector;
  let inspector: StateInspector;

  beforeEach(() => {
    collector = new MetricsCollector();
    const eventLog = new EventLog(100);
    inspector = new StateInspector(createMockContext(), collector, eventLog);
    panel = new DevToolsPanel(inspector, false);
  });

  it("should start hidden when autoStart is false", () => {
    expect(panel.isVisible()).toBe(false);
  });

  it("should start visible when autoStart is true", () => {
    const p = new DevToolsPanel(inspector, true);
    expect(p.isVisible()).toBe(true);
  });

  it("should toggle visibility", () => {
    expect(panel.toggle()).toBe(true);
    expect(panel.isVisible()).toBe(true);
    expect(panel.toggle()).toBe(false);
    expect(panel.isVisible()).toBe(false);
  });

  it("should switch views", () => {
    panel.switchView("events");
    expect(panel.getCurrentView()).toBe("events");
    panel.switchView("state");
    expect(panel.getCurrentView()).toBe("state");
  });

  it("should default to metrics view", () => {
    expect(panel.getCurrentView()).toBe("metrics");
  });

  it("should update on metrics snapshot", () => {
    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      counters: { test: 1 },
      gauges: {},
      timings: {},
    };
    panel.onMetricsSnapshot(snapshot);
    const state = panel.getState();
    expect(state.lastSnapshot).toEqual(snapshot);
    expect(state.lastState).not.toBeNull();
  });

  it("should return latest state after snapshot", () => {
    panel.onMetricsSnapshot({
      timestamp: Date.now(),
      counters: {},
      gauges: {},
      timings: {},
    });
    const latest = panel.getLatestState();
    expect(latest).not.toBeNull();
    expect(latest?.agentStatus).toBe("idle");
  });

  it("should return null state before any snapshot", () => {
    expect(panel.getLatestState()).toBeNull();
  });
});
