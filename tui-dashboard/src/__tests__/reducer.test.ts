import { describe, it, expect } from "vitest";
import { tuiReducer, initialState } from "../state/reducer.js";
import type { TuiState, TuiAction, Message } from "../state/types.js";

describe("tuiReducer", () => {
  it("returns initial state for unknown action", () => {
    const result = tuiReducer(initialState, { type: "UNKNOWN" } as unknown as TuiAction);
    expect(result).toBe(initialState);
  });

  it("handles AGENT_STARTED", () => {
    const action: TuiAction = {
      type: "AGENT_STARTED",
      payload: { name: "Test Agent", version: "2.0.0" },
    };
    const next = tuiReducer(initialState, action);

    expect(next.agentName).toBe("Test Agent");
    expect(next.agentVersion).toBe("2.0.0");
    expect(next.agentStatus).toBe("running");
  });

  it("handles AGENT_STOPPED", () => {
    const running: TuiState = { ...initialState, agentStatus: "running" };
    const next = tuiReducer(running, { type: "AGENT_STOPPED" });

    expect(next.agentStatus).toBe("stopped");
  });

  it("handles ADD_MESSAGE with a new message", () => {
    const msg: Message = {
      id: "msg-1",
      timestamp: 1000,
      type: "user",
      content: "Hello",
    };
    const next = tuiReducer(initialState, {
      type: "ADD_MESSAGE",
      payload: msg,
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toEqual(msg);
    expect(next.messageCount).toBe(1);
  });

  it("increments toolCallCount for tool-call messages", () => {
    const msg: Message = {
      id: "msg-t1",
      timestamp: 1000,
      type: "tool-call",
      content: "Calling: read_file",
      metadata: { toolName: "read_file" },
    };
    const next = tuiReducer(initialState, {
      type: "ADD_MESSAGE",
      payload: msg,
    });

    expect(next.toolCallCount).toBe(1);
  });

  it("increments errorCount for error messages", () => {
    const msg: Message = {
      id: "msg-e1",
      timestamp: 1000,
      type: "error",
      content: "Error: something went wrong",
    };
    const next = tuiReducer(initialState, {
      type: "ADD_MESSAGE",
      payload: msg,
    });

    expect(next.errorCount).toBe(1);
  });

  it("caps messages at MAX_MESSAGES (200)", () => {
    let state = initialState;
    for (let i = 0; i < 201; i++) {
      state = tuiReducer(state, {
        type: "ADD_MESSAGE",
        payload: {
          id: `msg-${i}`,
          timestamp: i * 1000,
          type: "user",
          content: `Message ${i}`,
        },
      });
    }

    expect(state.messages).toHaveLength(200);
    // First message should be the 2nd one (index 1), since the first was pushed out
    expect(state.messages[0].id).toBe("msg-1");
    expect(state.messageCount).toBe(201);
  });

  it("handles APPEND_STREAM creating a new streaming message", () => {
    const next = tuiReducer(initialState, {
      type: "APPEND_STREAM",
      payload: { content: "Hello", timestamp: 1000 },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBe("current-assistant");
    expect(next.messages[0].content).toBe("Hello");
    expect(next.messages[0].type).toBe("assistant");
  });

  it("handles APPEND_STREAM appending to existing streaming message", () => {
    const state1 = tuiReducer(initialState, {
      type: "APPEND_STREAM",
      payload: { content: "Hello", timestamp: 1000 },
    });
    const state2 = tuiReducer(state1, {
      type: "APPEND_STREAM",
      payload: { content: " world", timestamp: 1001 },
    });

    expect(state2.messages).toHaveLength(1);
    expect(state2.messages[0].content).toBe("Hello world");
    expect(state2.messageCount).toBe(1); // Still 1 message
  });

  it("handles FINALIZE_STREAM assigning deterministic permanent ID", () => {
    const state1 = tuiReducer(initialState, {
      type: "APPEND_STREAM",
      payload: { content: "Complete response", timestamp: 1000 },
    });
    const state2 = tuiReducer(state1, { type: "FINALIZE_STREAM" });

    expect(state2.messages).toHaveLength(1);
    expect(state2.messages[0].id).not.toBe("current-assistant");
    expect(state2.messages[0].id).toBe("msg-final-1");
    expect(state2.messages[0].content).toBe("Complete response");
  });

  it("APPEND_STREAM respects MAX_MESSAGES buffer when creating new stream", () => {
    let state = initialState;
    for (let i = 0; i < 200; i++) {
      state = tuiReducer(state, {
        type: "ADD_MESSAGE",
        payload: {
          id: `msg-${i}`,
          timestamp: i * 1000,
          type: "user",
          content: `Message ${i}`,
        },
      });
    }
    expect(state.messages).toHaveLength(200);

    // Starting a new stream should not exceed 200
    const next = tuiReducer(state, {
      type: "APPEND_STREAM",
      payload: { content: "Streaming...", timestamp: 999000 },
    });
    expect(next.messages).toHaveLength(200);
    expect(next.messages[199].id).toBe("current-assistant");
  });

  it("handles FINALIZE_STREAM when no streaming message exists", () => {
    const next = tuiReducer(initialState, { type: "FINALIZE_STREAM" });
    expect(next).toBe(initialState); // No change
  });

  it("handles ADD_EVENT", () => {
    const next = tuiReducer(initialState, {
      type: "ADD_EVENT",
      payload: { timestamp: 1000, type: "custom:event", payload: {} },
    });

    expect(next.events).toHaveLength(1);
    expect(next.eventCount).toBe(1);
    expect(next.events[0].type).toBe("custom:event");
  });

  it("caps events at MAX_EVENTS (500)", () => {
    let state = initialState;
    for (let i = 0; i < 501; i++) {
      state = tuiReducer(state, {
        type: "ADD_EVENT",
        payload: { timestamp: i * 1000, type: `event-${i}`, payload: {} },
      });
    }

    expect(state.events).toHaveLength(500);
    expect(state.events[0].type).toBe("event-1");
    expect(state.eventCount).toBe(501);
  });

  it("handles TOGGLE_EVENT_LOG", () => {
    expect(initialState.isEventLogVisible).toBe(false);

    const toggled = tuiReducer(initialState, { type: "TOGGLE_EVENT_LOG" });
    expect(toggled.isEventLogVisible).toBe(true);

    const toggledBack = tuiReducer(toggled, { type: "TOGGLE_EVENT_LOG" });
    expect(toggledBack.isEventLogVisible).toBe(false);
  });

  it("handles SCROLL_CHAT with positive delta", () => {
    const next = tuiReducer(initialState, {
      type: "SCROLL_CHAT",
      payload: { delta: 3 },
    });
    expect(next.chatScrollOffset).toBe(3);
  });

  it("handles SCROLL_CHAT clamped to zero", () => {
    const next = tuiReducer(initialState, {
      type: "SCROLL_CHAT",
      payload: { delta: -5 },
    });
    expect(next.chatScrollOffset).toBe(0);
  });

  it("handles SCROLL_EVENT_LOG", () => {
    const next = tuiReducer(initialState, {
      type: "SCROLL_EVENT_LOG",
      payload: { delta: 2 },
    });
    expect(next.eventScrollOffset).toBe(2);
  });

  it("handles SET_STATUS", () => {
    const next = tuiReducer(initialState, {
      type: "SET_STATUS",
      payload: "error",
    });
    expect(next.agentStatus).toBe("error");
  });

  it("does not mutate original state", () => {
    const original = { ...initialState };
    tuiReducer(initialState, { type: "TOGGLE_EVENT_LOG" });
    expect(initialState).toEqual(original);
  });

  it("resets chatScrollOffset on new message", () => {
    const scrolled: TuiState = { ...initialState, chatScrollOffset: 5 };
    const next = tuiReducer(scrolled, {
      type: "ADD_MESSAGE",
      payload: {
        id: "msg-1",
        timestamp: 1000,
        type: "user",
        content: "New message",
      },
    });
    expect(next.chatScrollOffset).toBe(0);
  });

  // Plan09 — Input-related actions
  describe("Plan09 Input Actions", () => {
    it("handles SET_INPUT_MODE switching between input and browse", () => {
      const browsing = tuiReducer(initialState, {
        type: "SET_INPUT_MODE",
        payload: "input",
      });
      expect(browsing.inputMode).toBe("input");

      const inputting = tuiReducer(browsing, {
        type: "SET_INPUT_MODE",
        payload: "browse",
      });
      expect(inputting.inputMode).toBe("browse");
    });

    it("handles SET_INPUT_TEXT updating inputText", () => {
      const next = tuiReducer(initialState, {
        type: "SET_INPUT_TEXT",
        payload: "hello",
      });
      expect(next.inputText).toBe("hello");
    });

    it("handles SUBMIT_INPUT adding to history and clearing input", () => {
      const next = tuiReducer(initialState, {
        type: "SUBMIT_INPUT",
        payload: { text: "test command", timestamp: 1000 },
      });
      expect(next.inputHistory).toEqual(["test command"]);
      expect(next.inputText).toBe("");
      expect(next.historyIndex).toBe(-1);
      expect(next.isPending).toBe(true);
    });

    it("SUBMIT_INPUT deduplicates consecutive entries", () => {
      const state1 = tuiReducer(initialState, {
        type: "SUBMIT_INPUT",
        payload: { text: "same", timestamp: 1000 },
      });
      const state2 = tuiReducer(state1, {
        type: "SUBMIT_INPUT",
        payload: { text: "same", timestamp: 2000 },
      });
      expect(state2.inputHistory).toEqual(["same"]); // Not duplicated
    });

    it("SUBMIT_INPUT caps history at MAX_HISTORY (50)", () => {
      let state = initialState;
      for (let i = 0; i < 55; i++) {
        state = tuiReducer(state, {
          type: "SUBMIT_INPUT",
          payload: { text: `command-${i}`, timestamp: i * 1000 },
        });
      }
      expect(state.inputHistory).toHaveLength(50);
      expect(state.inputHistory[0]).toBe("command-5"); // Oldest 5 dropped
      expect(state.inputHistory[49]).toBe("command-54");
    });

    it("SUBMIT_INPUT ignores empty input", () => {
      const next = tuiReducer(initialState, {
        type: "SUBMIT_INPUT",
        payload: { text: "   ", timestamp: 1000 },
      });
      expect(next.inputHistory).toEqual([]);
      expect(next).toBe(initialState); // No change
    });

    it("handles HISTORY_PREV navigating backward", () => {
      const withHistory: TuiState = {
        ...initialState,
        inputHistory: ["cmd1", "cmd2", "cmd3"],
      };

      // From -1 (not browsing) → jump to most recent
      const first = tuiReducer(withHistory, { type: "HISTORY_PREV" });
      expect(first.historyIndex).toBe(2);
      expect(first.inputText).toBe("cmd3");

      // Continue backward
      const second = tuiReducer(first, { type: "HISTORY_PREV" });
      expect(second.historyIndex).toBe(1);
      expect(second.inputText).toBe("cmd2");

      // Continue backward
      const third = tuiReducer(second, { type: "HISTORY_PREV" });
      expect(third.historyIndex).toBe(0);
      expect(third.inputText).toBe("cmd1");

      // Clamp at 0
      const clamped = tuiReducer(third, { type: "HISTORY_PREV" });
      expect(clamped.historyIndex).toBe(0);
      expect(clamped.inputText).toBe("cmd1");
    });

    it("handles HISTORY_NEXT navigating forward", () => {
      const withHistory: TuiState = {
        ...initialState,
        inputHistory: ["cmd1", "cmd2", "cmd3"],
        historyIndex: 0,
        inputText: "cmd1",
      };

      const first = tuiReducer(withHistory, { type: "HISTORY_NEXT" });
      expect(first.historyIndex).toBe(1);
      expect(first.inputText).toBe("cmd2");

      const second = tuiReducer(first, { type: "HISTORY_NEXT" });
      expect(second.historyIndex).toBe(2);
      expect(second.inputText).toBe("cmd3");

      // Go past last entry → reset
      const reset = tuiReducer(second, { type: "HISTORY_NEXT" });
      expect(reset.historyIndex).toBe(-1);
      expect(reset.inputText).toBe("");
    });

    it("HISTORY_PREV returns unchanged state when history is empty", () => {
      const next = tuiReducer(initialState, { type: "HISTORY_PREV" });
      expect(next).toBe(initialState);
    });

    it("HISTORY_NEXT returns unchanged state when not browsing history", () => {
      const next = tuiReducer(initialState, { type: "HISTORY_NEXT" });
      expect(next).toBe(initialState);
    });

    it("handles CLEAR_INPUT resetting text and history index", () => {
      const withInput: TuiState = {
        ...initialState,
        inputText: "some text",
        historyIndex: 2,
      };
      const next = tuiReducer(withInput, { type: "CLEAR_INPUT" });
      expect(next.inputText).toBe("");
      expect(next.historyIndex).toBe(-1);
    });

    it("handles SET_PENDING toggling isPending flag", () => {
      const pending = tuiReducer(initialState, {
        type: "SET_PENDING",
        payload: true,
      });
      expect(pending.isPending).toBe(true);

      const notPending = tuiReducer(pending, {
        type: "SET_PENDING",
        payload: false,
      });
      expect(notPending.isPending).toBe(false);
    });

    it("handles CLEAR_CHAT resetting messages and counters", () => {
      const withMessages: TuiState = {
        ...initialState,
        messages: [
          { id: "m1", timestamp: 1000, type: "user", content: "test" },
          { id: "m2", timestamp: 2000, type: "assistant", content: "reply" },
        ],
        messageCount: 2,
        chatScrollOffset: 5,
      };

      const next = tuiReducer(withMessages, { type: "CLEAR_CHAT" });
      expect(next.messages).toEqual([]);
      expect(next.messageCount).toBe(0);
      expect(next.chatScrollOffset).toBe(0);
    });
  });
});
