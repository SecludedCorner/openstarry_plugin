import { AgentEventType } from "@openstarry/sdk";
import type { AgentEvent } from "@openstarry/sdk";
import type { TuiAction } from "../state/types.js";
import { truncate } from "./format.js";

let messageCounter = 0;

function nextId(): string {
  return `msg-${++messageCounter}-${Date.now()}`;
}

/** Map an AgentEvent to a TuiAction for the reducer. Returns null for unhandled events. */
export function eventToAction(event: AgentEvent): TuiAction | null {
  const p = event.payload as Record<string, unknown> | undefined;

  switch (event.type) {
    case AgentEventType.AGENT_STARTED:
      return {
        type: "AGENT_STARTED",
        payload: {
          name:
            (p?.identity as Record<string, unknown>)?.name as string ??
            (p?.name as string) ??
            "Agent",
          version:
            (p?.identity as Record<string, unknown>)?.version as string ??
            (p?.version as string) ??
            "unknown",
        },
      };

    case AgentEventType.AGENT_STOPPED:
      return { type: "AGENT_STOPPED" };

    case AgentEventType.MESSAGE_USER:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "user",
          content: (p?.text as string) ?? (p?.content as string) ?? "",
        },
      };

    case AgentEventType.MESSAGE_SYSTEM:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "system",
          content: (p?.text as string) ?? (p?.content as string) ?? "",
        },
      };

    case AgentEventType.MESSAGE_ASSISTANT:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "assistant",
          content: (p?.text as string) ?? (p?.content as string) ?? "",
        },
      };

    case AgentEventType.STREAM_TEXT_DELTA:
      return {
        type: "APPEND_STREAM",
        payload: {
          content: (p?.text as string) ?? (p?.delta as string) ?? "",
          timestamp: event.timestamp,
        },
      };

    case AgentEventType.STREAM_FINISH:
      return { type: "FINALIZE_STREAM" };

    case AgentEventType.STREAM_TOOL_CALL_START:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "tool-call",
          content: `Calling: ${(p?.name as string) ?? "unknown"}`,
          metadata: { toolName: p?.name as string },
        },
      };

    case AgentEventType.TOOL_RESULT:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "tool-result",
          content: truncate(String(p?.result ?? ""), 500),
        },
      };

    case AgentEventType.TOOL_ERROR:
    case AgentEventType.STREAM_ERROR:
    case AgentEventType.LOOP_ERROR:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "error",
          content: `Error: ${(p?.error as string) ?? (p?.message as string) ?? "Unknown error"}`,
          metadata: { error: (p?.error as string) ?? (p?.message as string) },
        },
      };

    case AgentEventType.SAFETY_LOCKOUT:
      return {
        type: "ADD_MESSAGE",
        payload: {
          id: nextId(),
          timestamp: event.timestamp,
          type: "error",
          content: `[SAFETY LOCKOUT] ${(p?.error as string) ?? (p?.reason as string) ?? ""}`,
        },
      };

    case AgentEventType.LOOP_STARTED:
      return { type: "SET_PENDING", payload: true };

    case AgentEventType.LOOP_FINISHED:
      return { type: "SET_PENDING", payload: false };

    default:
      // All other events go to the debug event log
      return {
        type: "ADD_EVENT",
        payload: {
          timestamp: event.timestamp,
          type: event.type,
          payload: event.payload,
        },
      };
  }
}

/** Reset the internal message counter (for testing). */
export function _resetCounter(): void {
  messageCounter = 0;
}
