import { describe, it, expect, beforeEach } from "vitest";
import { eventToAction, _resetCounter } from "../utils/event-mapper.js";
import { AgentEventType } from "@openstarry/sdk";
import type { AgentEvent } from "@openstarry/sdk";

function makeEvent(type: string, payload: unknown = {}): AgentEvent {
  return { type, timestamp: 1000, payload } as AgentEvent;
}

describe("eventToAction", () => {
  beforeEach(() => {
    _resetCounter();
  });

  it("maps AGENT_STARTED to AGENT_STARTED action", () => {
    const event = makeEvent(AgentEventType.AGENT_STARTED, {
      identity: { name: "My Agent", version: "2.0.0" },
    });
    const action = eventToAction(event);

    expect(action).toEqual({
      type: "AGENT_STARTED",
      payload: { name: "My Agent", version: "2.0.0" },
    });
  });

  it("maps AGENT_STARTED with fallback name/version", () => {
    const event = makeEvent(AgentEventType.AGENT_STARTED, {});
    const action = eventToAction(event);

    expect(action).toEqual({
      type: "AGENT_STARTED",
      payload: { name: "Agent", version: "unknown" },
    });
  });

  it("maps AGENT_STOPPED", () => {
    const action = eventToAction(makeEvent(AgentEventType.AGENT_STOPPED));
    expect(action).toEqual({ type: "AGENT_STOPPED" });
  });

  it("maps MESSAGE_USER to ADD_MESSAGE with user type", () => {
    const event = makeEvent(AgentEventType.MESSAGE_USER, { text: "Hello!" });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("user");
      expect(action.payload.content).toBe("Hello!");
    }
  });

  it("maps MESSAGE_SYSTEM to ADD_MESSAGE with system type", () => {
    const event = makeEvent(AgentEventType.MESSAGE_SYSTEM, { text: "System init" });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("system");
      expect(action.payload.content).toBe("System init");
    }
  });

  it("maps MESSAGE_ASSISTANT to ADD_MESSAGE with assistant type", () => {
    const event = makeEvent(AgentEventType.MESSAGE_ASSISTANT, { text: "Hello user" });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("assistant");
      expect(action.payload.content).toBe("Hello user");
    }
  });

  it("maps LOOP_ERROR to ADD_MESSAGE with error type", () => {
    const event = makeEvent(AgentEventType.LOOP_ERROR, { error: "Loop failed" });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("error");
      expect(action.payload.content).toContain("Loop failed");
    }
  });

  it("maps STREAM_TEXT_DELTA to APPEND_STREAM", () => {
    const event = makeEvent(AgentEventType.STREAM_TEXT_DELTA, { text: "chunk" });
    const action = eventToAction(event);

    expect(action).toEqual({
      type: "APPEND_STREAM",
      payload: { content: "chunk", timestamp: 1000 },
    });
  });

  it("maps STREAM_FINISH to FINALIZE_STREAM", () => {
    const action = eventToAction(makeEvent(AgentEventType.STREAM_FINISH));
    expect(action).toEqual({ type: "FINALIZE_STREAM" });
  });

  it("maps STREAM_TOOL_CALL_START to ADD_MESSAGE with tool-call type", () => {
    const event = makeEvent(AgentEventType.STREAM_TOOL_CALL_START, {
      name: "read_file",
    });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("tool-call");
      expect(action.payload.content).toContain("read_file");
      expect(action.payload.metadata?.toolName).toBe("read_file");
    }
  });

  it("maps TOOL_RESULT with truncation", () => {
    const longResult = "x".repeat(1000);
    const event = makeEvent(AgentEventType.TOOL_RESULT, { result: longResult });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("tool-result");
      expect(action.payload.content.length).toBeLessThanOrEqual(503); // 500 + "..."
    }
  });

  it("maps TOOL_ERROR to ADD_MESSAGE with error type", () => {
    const event = makeEvent(AgentEventType.TOOL_ERROR, { error: "File not found" });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("error");
      expect(action.payload.content).toContain("File not found");
    }
  });

  it("maps STREAM_ERROR to ADD_MESSAGE with error type", () => {
    const event = makeEvent(AgentEventType.STREAM_ERROR, { error: "Connection lost" });
    const action = eventToAction(event);

    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("error");
      expect(action.payload.content).toContain("Connection lost");
    }
  });

  it("maps SAFETY_LOCKOUT to error message", () => {
    const event = makeEvent(AgentEventType.SAFETY_LOCKOUT, {
      error: "Token limit exceeded",
    });
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.type).toBe("error");
      expect(action.payload.content).toContain("SAFETY LOCKOUT");
      expect(action.payload.content).toContain("Token limit exceeded");
    }
  });

  it("maps unknown events to ADD_EVENT", () => {
    const event = makeEvent("custom:unknown", { data: "test" });
    const action = eventToAction(event);

    expect(action).toEqual({
      type: "ADD_EVENT",
      payload: { timestamp: 1000, type: "custom:unknown", payload: { data: "test" } },
    });
  });

  it("handles missing payload gracefully", () => {
    const event: AgentEvent = {
      type: AgentEventType.MESSAGE_USER,
      timestamp: 1000,
    } as AgentEvent;
    const action = eventToAction(event);

    expect(action?.type).toBe("ADD_MESSAGE");
    if (action?.type === "ADD_MESSAGE") {
      expect(action.payload.content).toBe("");
    }
  });
});
