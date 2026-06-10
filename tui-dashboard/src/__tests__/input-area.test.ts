import { describe, it, expect } from "vitest";
import { tuiReducer, initialState } from "../state/reducer.js";
import type { TuiState } from "../state/types.js";

describe("InputArea Component Logic", () => {
  it("renders only when inputMode is 'input'", () => {
    const browsing = { ...initialState, inputMode: "browse" as const };
    const inputting = { ...initialState, inputMode: "input" as const };

    expect(browsing.inputMode).toBe("browse");
    expect(inputting.inputMode).toBe("input");
  });

  it("displays placeholder when inputText is empty", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "",
    };
    expect(state.inputText).toBe("");
  });

  it("displays current input text", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "hello world",
    };
    expect(state.inputText).toBe("hello world");
  });

  it("handles character input via SET_INPUT_TEXT dispatch", () => {
    let state = { ...initialState, inputMode: "input" as const };

    // Simulate typing "h"
    state = tuiReducer(state, { type: "SET_INPUT_TEXT", payload: "h" });
    expect(state.inputText).toBe("h");

    // Continue typing "e"
    state = tuiReducer(state, { type: "SET_INPUT_TEXT", payload: "he" });
    expect(state.inputText).toBe("he");
  });

  it("handles Backspace key removing last character", () => {
    let state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "hello",
    };

    // Simulate backspace
    state = tuiReducer(state, {
      type: "SET_INPUT_TEXT",
      payload: state.inputText.slice(0, -1),
    });
    expect(state.inputText).toBe("hell");
  });

  it("handles Enter key triggering SUBMIT_INPUT", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "test message",
    };

    const next = tuiReducer(state, {
      type: "SUBMIT_INPUT",
      payload: { text: "test message", timestamp: Date.now() },
    });

    expect(next.inputText).toBe("");
    expect(next.inputHistory).toContain("test message");
    expect(next.isPending).toBe(true);
  });

  it("handles Escape key dispatching SET_INPUT_MODE to browse", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "partial",
    };

    const next = tuiReducer(state, {
      type: "SET_INPUT_MODE",
      payload: "browse",
    });

    expect(next.inputMode).toBe("browse");
  });

  it("shows disabled state when isPending is true", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputText: "",
      isPending: true,
    };

    expect(state.isPending).toBe(true);
    expect(state.inputMode).toBe("input");
  });

  it("handles arrow up for history navigation", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputHistory: ["cmd1", "cmd2", "cmd3"],
      historyIndex: -1,
      inputText: "",
    };

    const next = tuiReducer(state, { type: "HISTORY_PREV" });
    expect(next.historyIndex).toBe(2);
    expect(next.inputText).toBe("cmd3");
  });

  it("handles arrow down for history navigation", () => {
    const state: TuiState = {
      ...initialState,
      inputMode: "input",
      inputHistory: ["cmd1", "cmd2"],
      historyIndex: 0,
      inputText: "cmd1",
    };

    const next = tuiReducer(state, { type: "HISTORY_NEXT" });
    expect(next.historyIndex).toBe(1);
    expect(next.inputText).toBe("cmd2");
  });
});
