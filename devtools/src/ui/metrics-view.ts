/**
 * MetricsView — renders metrics data as formatted strings.
 * Pure data view (no Ink dependency) for testability.
 */
import type { MetricsSnapshot } from "../types/state.js";
import { formatNumber, formatBytes } from "../state/formatter.js";

export interface MetricsViewData {
  counters: Array<{ name: string; value: string }>;
  timings: Array<{ name: string; avg: string; min: string; max: string; count: number }>;
  gauges: Array<{ name: string; value: string }>;
}

export function buildMetricsView(snapshot: MetricsSnapshot): MetricsViewData {
  const counters = Object.entries(snapshot.counters).map(([name, value]) => ({
    name,
    value: formatNumber(value),
  }));

  const timings = Object.entries(snapshot.timings).map(([name, t]) => ({
    name,
    avg: `${t.avg.toFixed(1)}ms`,
    min: `${t.min}ms`,
    max: `${t.max}ms`,
    count: t.count,
  }));

  const gauges = Object.entries(snapshot.gauges).map(([name, value]) => ({
    name,
    value: String(value),
  }));

  return { counters, timings, gauges };
}
