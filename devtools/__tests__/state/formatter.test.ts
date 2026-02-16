import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatSessionStatus,
  formatToolMetrics,
  formatSystemMetrics,
  formatEventTimeline,
  formatMetricsSnapshot,
} from "../../src/state/formatter.js";
import type { DevToolsState, MetricsSnapshot } from "../../src/types/state.js";

describe("formatBytes", () => {
  it("should format bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("should format kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("should format megabytes", () => {
    expect(formatBytes(1024 * 1024 * 87)).toContain("MB");
  });

  it("should format gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toContain("GB");
  });
});

describe("formatDuration", () => {
  it("should format seconds", () => {
    expect(formatDuration(45.3)).toBe("45.3s");
  });

  it("should format minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("should format hours", () => {
    expect(formatDuration(3700)).toContain("h");
  });
});

describe("formatNumber", () => {
  it("should format small numbers as-is", () => {
    expect(formatNumber(42)).toBe("42");
  });

  it("should format thousands with K", () => {
    expect(formatNumber(1500)).toBe("1.5K");
  });

  it("should format millions with M", () => {
    expect(formatNumber(2_500_000)).toBe("2.5M");
  });
});

describe("formatSessionStatus", () => {
  it("should format session info", () => {
    const state: DevToolsState = {
      sessionStatus: { active: 2, total: 5, defaultSession: "default" },
      toolMetrics: { totalCalls: 0, successCount: 0, errorCount: 0, byTool: {} },
      systemMetrics: { uptime: 0, loopCount: 0, eventCount: 0, memoryUsage: { heapUsed: 0, heapTotal: 0, external: 0 } },
      recentEvents: [],
      agentStatus: "idle",
    };
    const result = formatSessionStatus(state);
    expect(result).toContain("2 active");
    expect(result).toContain("5 total");
    expect(result).toContain("default");
  });
});

describe("formatEventTimeline", () => {
  it("should return (no events) for empty list", () => {
    expect(formatEventTimeline([])).toBe("(no events)");
  });

  it("should format events with timestamps", () => {
    const events = [
      { timestamp: Date.now(), type: "test:event", payload: "data" },
    ];
    const result = formatEventTimeline(events);
    expect(result).toContain("test:event");
  });
});

describe("formatMetricsSnapshot", () => {
  it("should format snapshot with counters and timings", () => {
    const snap: MetricsSnapshot = {
      timestamp: Date.now(),
      counters: { "events.total": 100 },
      gauges: {},
      timings: {
        "loop.duration": { count: 5, sum: 500, min: 50, max: 150, avg: 100 },
      },
    };
    const result = formatMetricsSnapshot(snap);
    expect(result).toContain("DevTools Metrics Snapshot");
    expect(result).toContain("events.total");
    expect(result).toContain("loop.duration");
  });
});
