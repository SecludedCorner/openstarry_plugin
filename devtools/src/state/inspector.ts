/**
 * StateInspector — generates DevToolsState snapshots from agent context.
 */
import type { IPluginContext, AgentEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { DevToolsState, IMetricsCollector } from "../types/state.js";

export class EventLog {
  private events: Array<{ timestamp: number; type: string; payload?: unknown }> = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(event: AgentEvent): void {
    this.events.push({
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
    });
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getRecent(count: number): Array<{ timestamp: number; type: string; payload?: unknown }> {
    return this.events.slice(-count);
  }

  getAll(): Array<{ timestamp: number; type: string; payload?: unknown }> {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  get size(): number {
    return this.events.length;
  }
}

export class StateInspector {
  private startTime: number = Date.now();
  private agentStatus: DevToolsState["agentStatus"] = "idle";
  private readonly ctx: IPluginContext;
  private readonly collector: IMetricsCollector;
  private readonly eventLog: EventLog;

  constructor(ctx: IPluginContext, collector: IMetricsCollector, eventLog: EventLog) {
    this.ctx = ctx;
    this.collector = collector;
    this.eventLog = eventLog;
  }

  updateStatus(event: AgentEvent): void {
    switch (event.type) {
      case AgentEventType.AGENT_STARTED:
        this.agentStatus = "idle";
        this.startTime = event.timestamp;
        break;
      case AgentEventType.AGENT_STOPPED:
        this.agentStatus = "stopped";
        break;
      case AgentEventType.LOOP_STARTED:
        this.agentStatus = "processing";
        break;
      case AgentEventType.LOOP_FINISHED:
        this.agentStatus = "idle";
        break;
      case AgentEventType.LOOP_ERROR:
        this.agentStatus = "error";
        break;
    }
  }

  snapshot(): DevToolsState {
    const sessions = this.ctx.sessions.list();
    const defaultSession = this.ctx.sessions.getDefaultSession();
    const metricsSnap = this.collector.getSnapshot();
    const mem = process.memoryUsage();

    return {
      sessionStatus: {
        active: sessions.length,
        total: (metricsSnap.counters["sessions.created"] ?? 0),
        defaultSession: defaultSession?.id ?? null,
      },
      toolMetrics: {
        totalCalls: metricsSnap.counters["tools.total"] ?? 0,
        successCount: metricsSnap.counters["tools.success"] ?? 0,
        errorCount: metricsSnap.counters["tools.errors"] ?? 0,
        byTool: this.extractToolMetrics(metricsSnap),
      },
      systemMetrics: {
        uptime: (Date.now() - this.startTime) / 1000,
        loopCount: metricsSnap.counters["loops.total"] ?? 0,
        eventCount: metricsSnap.counters["events.total"] ?? 0,
        memoryUsage: {
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
      },
      recentEvents: this.eventLog.getRecent(20),
      agentStatus: this.agentStatus,
    };
  }

  private extractToolMetrics(
    snap: ReturnType<IMetricsCollector["getSnapshot"]>,
  ): Record<string, { calls: number; success: number; errors: number }> {
    const result: Record<string, { calls: number; success: number; errors: number }> = {};
    for (const key of Object.keys(snap.counters)) {
      const match = key.match(/^tools\.by\.(.+)\.calls$/);
      if (match) {
        const toolName = match[1];
        result[toolName] = {
          calls: snap.counters[`tools.by.${toolName}.calls`] ?? 0,
          success: snap.counters[`tools.by.${toolName}.success`] ?? 0,
          errors: snap.counters[`tools.by.${toolName}.errors`] ?? 0,
        };
      }
    }
    return result;
  }
}
