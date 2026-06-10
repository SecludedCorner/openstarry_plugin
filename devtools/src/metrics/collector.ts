/**
 * MetricsCollector — aggregates metrics from agent events.
 * Implements IMetricsCollector (FROZEN interface).
 */
import type { IMetricsCollector, MetricsSnapshot } from "../types/state.js";

interface TimingData {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export class MetricsCollector implements IMetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private timingsData: Map<string, TimingData> = new Map();

  increment(metric: string, value = 1): void {
    const current = this.counters.get(metric) ?? 0;
    this.counters.set(metric, current + value);
  }

  gauge(metric: string, value: number): void {
    this.gauges.set(metric, value);
  }

  timing(metric: string, durationMs: number): void {
    const existing = this.timingsData.get(metric);
    if (existing) {
      existing.count += 1;
      existing.sum += durationMs;
      existing.min = Math.min(existing.min, durationMs);
      existing.max = Math.max(existing.max, durationMs);
    } else {
      this.timingsData.set(metric, {
        count: 1,
        sum: durationMs,
        min: durationMs,
        max: durationMs,
      });
    }
  }

  getSnapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;

    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;

    const timings: MetricsSnapshot["timings"] = {};
    for (const [k, v] of this.timingsData) {
      timings[k] = {
        count: v.count,
        sum: v.sum,
        min: v.min,
        max: v.max,
        avg: v.count > 0 ? v.sum / v.count : 0,
      };
    }

    return { timestamp: Date.now(), counters, gauges, timings };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.timingsData.clear();
  }
}
