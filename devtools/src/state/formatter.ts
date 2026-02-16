/**
 * StateFormatter — formats DevToolsState into human-readable strings.
 */
import type { DevToolsState } from "../types/state.js";
import type { MetricsSnapshot } from "../types/state.js";

/**
 * Format bytes to human-readable string with appropriate unit.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format seconds to human-readable duration.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/**
 * Format a number with K/M/G suffix for large values.
 */
export function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}G`;
}

/**
 * Format session status line.
 */
export function formatSessionStatus(state: DevToolsState): string {
  const { active, total, defaultSession } = state.sessionStatus;
  const defaultStr = defaultSession ? ` (default: ${defaultSession})` : "";
  return `Sessions: ${active} active / ${total} total${defaultStr}`;
}

/**
 * Format tool metrics table.
 */
export function formatToolMetrics(state: DevToolsState): string {
  const { totalCalls, successCount, errorCount, byTool } = state.toolMetrics;
  const successRate = totalCalls > 0 ? ((successCount / totalCalls) * 100).toFixed(0) : "0";
  const lines: string[] = [
    `Tool Calls: ${totalCalls} (${successRate}% success, ${errorCount} errors)`,
  ];
  for (const [name, stats] of Object.entries(byTool)) {
    lines.push(`  ${name}: ${stats.calls} calls (${stats.success} ok, ${stats.errors} err)`);
  }
  return lines.join("\n");
}

/**
 * Format system metrics summary.
 */
export function formatSystemMetrics(state: DevToolsState): string {
  const { uptime, loopCount, eventCount, memoryUsage } = state.systemMetrics;
  return [
    `Uptime: ${formatDuration(uptime)}  |  Loops: ${loopCount}  |  Events: ${formatNumber(eventCount)}`,
    `Memory: ${formatBytes(memoryUsage.heapUsed)} / ${formatBytes(memoryUsage.heapTotal)}`,
  ].join("\n");
}

/**
 * Format event timeline.
 */
export function formatEventTimeline(
  events: DevToolsState["recentEvents"],
  maxEntries = 10,
): string {
  if (events.length === 0) return "(no events)";
  const recent = events.slice(-maxEntries).reverse();
  return recent
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString();
      const payload = e.payload ? ` ${truncate(JSON.stringify(e.payload), 60)}` : "";
      return `  [${time}] ${e.type}${payload}`;
    })
    .join("\n");
}

/**
 * Format complete metrics snapshot for /metrics command.
 */
export function formatMetricsSnapshot(snapshot: MetricsSnapshot): string {
  const lines: string[] = [
    "DevTools Metrics Snapshot",
    `Timestamp: ${new Date(snapshot.timestamp).toISOString()}`,
    "",
    "Counters:",
  ];

  for (const [k, v] of Object.entries(snapshot.counters)) {
    lines.push(`  ${k}: ${formatNumber(v)}`);
  }

  if (Object.keys(snapshot.gauges).length > 0) {
    lines.push("", "Gauges:");
    for (const [k, v] of Object.entries(snapshot.gauges)) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  if (Object.keys(snapshot.timings).length > 0) {
    lines.push("", "Timings:");
    for (const [k, v] of Object.entries(snapshot.timings)) {
      lines.push(`  ${k}: avg=${v.avg.toFixed(1)}ms min=${v.min}ms max=${v.max}ms (${v.count} samples)`);
    }
  }

  return lines.join("\n");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
