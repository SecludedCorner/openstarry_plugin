import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../../src/metrics/collector.js";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("should increment counter by 1 by default", () => {
    collector.increment("test.counter");
    const snap = collector.getSnapshot();
    expect(snap.counters["test.counter"]).toBe(1);
  });

  it("should increment counter by custom value", () => {
    collector.increment("test.counter", 5);
    const snap = collector.getSnapshot();
    expect(snap.counters["test.counter"]).toBe(5);
  });

  it("should accumulate increments", () => {
    collector.increment("test.counter");
    collector.increment("test.counter");
    collector.increment("test.counter", 3);
    const snap = collector.getSnapshot();
    expect(snap.counters["test.counter"]).toBe(5);
  });

  it("should set gauge to absolute value", () => {
    collector.gauge("test.gauge", 42);
    const snap = collector.getSnapshot();
    expect(snap.gauges["test.gauge"]).toBe(42);
  });

  it("should overwrite gauge on subsequent set", () => {
    collector.gauge("test.gauge", 10);
    collector.gauge("test.gauge", 20);
    const snap = collector.getSnapshot();
    expect(snap.gauges["test.gauge"]).toBe(20);
  });

  it("should record timing with min/max/avg/sum/count", () => {
    collector.timing("test.timing", 100);
    collector.timing("test.timing", 200);
    collector.timing("test.timing", 300);
    const snap = collector.getSnapshot();
    const t = snap.timings["test.timing"];
    expect(t.count).toBe(3);
    expect(t.sum).toBe(600);
    expect(t.min).toBe(100);
    expect(t.max).toBe(300);
    expect(t.avg).toBe(200);
  });

  it("should handle single timing correctly", () => {
    collector.timing("test.single", 50);
    const snap = collector.getSnapshot();
    const t = snap.timings["test.single"];
    expect(t.count).toBe(1);
    expect(t.avg).toBe(50);
    expect(t.min).toBe(50);
    expect(t.max).toBe(50);
  });

  it("should return snapshot with timestamp", () => {
    const before = Date.now();
    const snap = collector.getSnapshot();
    const after = Date.now();
    expect(snap.timestamp).toBeGreaterThanOrEqual(before);
    expect(snap.timestamp).toBeLessThanOrEqual(after);
  });

  it("should reset all metrics", () => {
    collector.increment("c1");
    collector.gauge("g1", 10);
    collector.timing("t1", 100);
    collector.reset();
    const snap = collector.getSnapshot();
    expect(Object.keys(snap.counters)).toHaveLength(0);
    expect(Object.keys(snap.gauges)).toHaveLength(0);
    expect(Object.keys(snap.timings)).toHaveLength(0);
  });

  it("should handle timing with zero duration", () => {
    collector.timing("test.zero", 0);
    const snap = collector.getSnapshot();
    expect(snap.timings["test.zero"].min).toBe(0);
    expect(snap.timings["test.zero"].avg).toBe(0);
  });
});
