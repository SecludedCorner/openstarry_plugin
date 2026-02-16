/**
 * Metrics aggregation helpers.
 * Processes AgentEvents and updates MetricsCollector.
 */
import type { AgentEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { IMetricsCollector } from "../types/state.js";

/** Map of loop start times for latency calculation */
const loopStartTimes = new Map<string, number>();

/**
 * Process an agent event and update metrics accordingly.
 */
export function processEvent(
  event: AgentEvent,
  collector: IMetricsCollector,
): void {
  collector.increment("events.total");

  switch (event.type) {
    case AgentEventType.LOOP_STARTED:
      collector.increment("loops.total");
      loopStartTimes.set("current", event.timestamp);
      break;

    case AgentEventType.LOOP_FINISHED: {
      const startTime = loopStartTimes.get("current");
      if (startTime) {
        collector.timing("loop.duration", event.timestamp - startTime);
        loopStartTimes.delete("current");
      }
      break;
    }

    case AgentEventType.LOOP_ERROR:
      collector.increment("loops.errors");
      loopStartTimes.delete("current");
      break;

    case AgentEventType.TOOL_EXECUTING: {
      collector.increment("tools.total");
      const toolName = (event.payload as any)?.toolName ?? "unknown";
      collector.increment(`tools.by.${toolName}.calls`);
      break;
    }

    case AgentEventType.TOOL_RESULT: {
      collector.increment("tools.success");
      const toolName = (event.payload as any)?.toolName ?? "unknown";
      collector.increment(`tools.by.${toolName}.success`);
      break;
    }

    case AgentEventType.TOOL_ERROR: {
      collector.increment("tools.errors");
      const toolName = (event.payload as any)?.toolName ?? "unknown";
      collector.increment(`tools.by.${toolName}.errors`);
      break;
    }

    case AgentEventType.SESSION_CREATED:
      collector.increment("sessions.created");
      break;

    case AgentEventType.SESSION_DESTROYED:
      collector.increment("sessions.destroyed");
      break;

    default:
      break;
  }
}
