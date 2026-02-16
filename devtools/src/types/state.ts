/**
 * DevTools state snapshot interface.
 * FROZEN — Architecture Spec Cycle 12, Section 1.1
 */
export interface DevToolsState {
  /** Current session status */
  sessionStatus: {
    active: number;
    total: number;
    defaultSession: string | null;
  };

  /** Tool execution metrics */
  toolMetrics: {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    byTool: Record<string, { calls: number; success: number; errors: number }>;
  };

  /** System metrics */
  systemMetrics: {
    uptime: number;
    loopCount: number;
    eventCount: number;
    memoryUsage: {
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
  };

  /** Recent events (last N) */
  recentEvents: Array<{
    timestamp: number;
    type: string;
    payload?: unknown;
  }>;

  /** Current agent status */
  agentStatus: "idle" | "processing" | "error" | "stopped";
}

/**
 * Metrics collector interface.
 * FROZEN — Architecture Spec Cycle 12, Section 1.1
 */
export interface IMetricsCollector {
  /** Increment a counter metric */
  increment(metric: string, value?: number): void;

  /** Set a gauge metric */
  gauge(metric: string, value: number): void;

  /** Record a timing metric in milliseconds */
  timing(metric: string, durationMs: number): void;

  /** Get current metrics snapshot */
  getSnapshot(): MetricsSnapshot;

  /** Reset all metrics */
  reset(): void;
}

/**
 * Metrics snapshot for export.
 * FROZEN — Architecture Spec Cycle 12, Section 1.1
 */
export interface MetricsSnapshot {
  timestamp: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timings: Record<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      avg: number;
    }
  >;
}
