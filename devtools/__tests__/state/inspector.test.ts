import { describe, it, expect, beforeEach } from "vitest";
import { EventLog, StateInspector } from "../../src/state/inspector.js";
import { MetricsCollector } from "../../src/metrics/collector.js";
import { AgentEventType } from "@openstarry/sdk";

function createMockContext(): any {
  return {
    sessions: {
      list: () => [{ id: "__default__", metadata: {} }],
      getDefaultSession: () => ({ id: "__default__", metadata: {} }),
    },
    bus: { onAny: () => () => {}, emit: () => {} },
  };
}

describe("EventLog", () => {
  it("should push and retrieve events", () => {
    const log = new EventLog(100);
    log.push({ type: "test", timestamp: 1000 });
    log.push({ type: "test2", timestamp: 2000 });
    expect(log.size).toBe(2);
    expect(log.getAll()).toHaveLength(2);
  });

  it("should respect max size and evict oldest", () => {
    const log = new EventLog(3);
    log.push({ type: "a", timestamp: 1 });
    log.push({ type: "b", timestamp: 2 });
    log.push({ type: "c", timestamp: 3 });
    log.push({ type: "d", timestamp: 4 });
    expect(log.size).toBe(3);
    expect(log.getAll()[0].type).toBe("b");
  });

  it("should return recent events", () => {
    const log = new EventLog(100);
    for (let i = 0; i < 10; i++) {
      log.push({ type: `event-${i}`, timestamp: i });
    }
    const recent = log.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].type).toBe("event-7");
  });

  it("should clear all events", () => {
    const log = new EventLog(100);
    log.push({ type: "test", timestamp: 1 });
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe("StateInspector", () => {
  let inspector: StateInspector;
  let collector: MetricsCollector;
  let eventLog: EventLog;

  beforeEach(() => {
    collector = new MetricsCollector();
    eventLog = new EventLog(100);
    inspector = new StateInspector(createMockContext(), collector, eventLog);
  });

  it("should generate snapshot with session status", () => {
    const state = inspector.snapshot();
    expect(state.sessionStatus.active).toBe(1);
    expect(state.sessionStatus.defaultSession).toBe("__default__");
  });

  it("should start with idle agent status", () => {
    const state = inspector.snapshot();
    expect(state.agentStatus).toBe("idle");
  });

  it("should update status on LOOP_STARTED", () => {
    inspector.updateStatus({
      type: AgentEventType.LOOP_STARTED,
      timestamp: Date.now(),
    });
    expect(inspector.snapshot().agentStatus).toBe("processing");
  });

  it("should update status on LOOP_FINISHED", () => {
    inspector.updateStatus({
      type: AgentEventType.LOOP_STARTED,
      timestamp: Date.now(),
    });
    inspector.updateStatus({
      type: AgentEventType.LOOP_FINISHED,
      timestamp: Date.now(),
    });
    expect(inspector.snapshot().agentStatus).toBe("idle");
  });

  it("should update status on LOOP_ERROR", () => {
    inspector.updateStatus({
      type: AgentEventType.LOOP_ERROR,
      timestamp: Date.now(),
    });
    expect(inspector.snapshot().agentStatus).toBe("error");
  });

  it("should capture memory usage", () => {
    const state = inspector.snapshot();
    expect(state.systemMetrics.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(state.systemMetrics.memoryUsage.heapTotal).toBeGreaterThan(0);
  });

  it("should extract tool metrics from collector", () => {
    collector.increment("tools.total", 5);
    collector.increment("tools.success", 4);
    collector.increment("tools.errors", 1);
    collector.increment("tools.by.fs.read.calls", 3);
    collector.increment("tools.by.fs.read.success", 3);
    collector.increment("tools.by.fs.read.errors", 0);
    const state = inspector.snapshot();
    expect(state.toolMetrics.totalCalls).toBe(5);
    expect(state.toolMetrics.successCount).toBe(4);
    expect(state.toolMetrics.byTool["fs.read"]).toBeDefined();
  });
});
