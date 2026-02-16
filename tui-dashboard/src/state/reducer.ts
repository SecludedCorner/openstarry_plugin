import type { TuiState, TuiAction } from "./types.js";

const MAX_MESSAGES = 200;
const MAX_EVENTS = 500;
const MAX_HISTORY = 50;

export const initialState: TuiState = {
  agentName: "OpenStarry Agent",
  agentStatus: "stopped",
  agentVersion: "unknown",
  messages: [],
  messageCount: 0,
  events: [],
  eventCount: 0,
  isEventLogVisible: false,
  chatScrollOffset: 0,
  eventScrollOffset: 0,
  toolCallCount: 0,
  errorCount: 0,
  // Plan09 — Input state
  inputMode: "browse",
  inputText: "",
  inputHistory: [],
  historyIndex: -1,
  isPending: false,
};

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "AGENT_STARTED":
      return {
        ...state,
        agentName: action.payload.name,
        agentVersion: action.payload.version,
        agentStatus: "running",
      };

    case "AGENT_STOPPED":
      return { ...state, agentStatus: "stopped" };

    case "ADD_MESSAGE": {
      const msg = action.payload;
      const isToolCall = msg.type === "tool-call";
      const isError = msg.type === "error";

      const messages =
        state.messages.length >= MAX_MESSAGES
          ? [...state.messages.slice(1), msg]
          : [...state.messages, msg];

      return {
        ...state,
        messages,
        messageCount: state.messageCount + 1,
        toolCallCount: state.toolCallCount + (isToolCall ? 1 : 0),
        errorCount: state.errorCount + (isError ? 1 : 0),
        chatScrollOffset: 0,
      };
    }

    case "APPEND_STREAM": {
      const existing = state.messages.findIndex(
        (m) => m.id === "current-assistant",
      );
      if (existing !== -1) {
        const updated = [...state.messages];
        updated[existing] = {
          ...updated[existing],
          content: updated[existing].content + action.payload.content,
        };
        return { ...state, messages: updated };
      }
      // Create new streaming message (respect buffer limit)
      const newMsg = {
        id: "current-assistant" as const,
        timestamp: action.payload.timestamp,
        type: "assistant" as const,
        content: action.payload.content,
      };
      const msgs =
        state.messages.length >= MAX_MESSAGES
          ? [...state.messages.slice(1), newMsg]
          : [...state.messages, newMsg];
      return {
        ...state,
        messages: msgs,
        messageCount: state.messageCount + 1,
        chatScrollOffset: 0,
      };
    }

    case "FINALIZE_STREAM": {
      const idx = state.messages.findIndex(
        (m) => m.id === "current-assistant",
      );
      if (idx === -1) return state;
      const updated = [...state.messages];
      updated[idx] = {
        ...updated[idx],
        id: `msg-final-${state.messageCount}`,
      };
      return { ...state, messages: updated };
    }

    case "ADD_EVENT": {
      const events =
        state.events.length >= MAX_EVENTS
          ? [...state.events.slice(1), action.payload]
          : [...state.events, action.payload];
      return {
        ...state,
        events,
        eventCount: state.eventCount + 1,
      };
    }

    case "TOGGLE_EVENT_LOG":
      return { ...state, isEventLogVisible: !state.isEventLogVisible };

    case "SCROLL_CHAT":
      return {
        ...state,
        chatScrollOffset: Math.max(
          0,
          state.chatScrollOffset + action.payload.delta,
        ),
      };

    case "SCROLL_EVENT_LOG":
      return {
        ...state,
        eventScrollOffset: Math.max(
          0,
          state.eventScrollOffset + action.payload.delta,
        ),
      };

    case "SET_STATUS":
      return { ...state, agentStatus: action.payload };

    // Plan09 — Input-related actions
    case "SET_INPUT_MODE":
      return { ...state, inputMode: action.payload };

    case "SET_INPUT_TEXT":
      return { ...state, inputText: action.payload };

    case "HISTORY_PREV": {
      if (state.inputHistory.length === 0) return state;
      const newIndex =
        state.historyIndex === -1
          ? state.inputHistory.length - 1
          : Math.max(0, state.historyIndex - 1);
      return {
        ...state,
        historyIndex: newIndex,
        inputText: state.inputHistory[newIndex] ?? "",
      };
    }

    case "HISTORY_NEXT": {
      if (state.historyIndex === -1) return state;
      const newIndex = state.historyIndex + 1;
      if (newIndex >= state.inputHistory.length) {
        return { ...state, historyIndex: -1, inputText: "" };
      }
      return {
        ...state,
        historyIndex: newIndex,
        inputText: state.inputHistory[newIndex] ?? "",
      };
    }

    case "SUBMIT_INPUT": {
      const { text } = action.payload;
      const trimmed = text.trim();
      if (!trimmed) return state;

      // Add to history (max 50, dedup consecutive)
      const lastEntry = state.inputHistory[state.inputHistory.length - 1];
      const newHistory =
        lastEntry === trimmed
          ? state.inputHistory
          : [...state.inputHistory, trimmed].slice(-MAX_HISTORY);

      return {
        ...state,
        inputHistory: newHistory,
        historyIndex: -1,
        inputText: "",
        isPending: true,
      };
    }

    case "CLEAR_INPUT":
      return { ...state, inputText: "", historyIndex: -1 };

    case "SET_PENDING":
      return { ...state, isPending: action.payload };

    case "CLEAR_CHAT":
      return {
        ...state,
        messages: [],
        messageCount: 0,
        chatScrollOffset: 0,
      };

    default:
      return state;
  }
}
