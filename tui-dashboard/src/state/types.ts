/** Display message types for the chat area. */
export interface Message {
  id: string;
  timestamp: number;
  type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "system";
  content: string;
  metadata?: {
    toolName?: string;
    error?: string;
  };
}

/** Raw event entry for the debug event log sidebar. */
export interface EventLogEntry {
  timestamp: number;
  type: string;
  payload: unknown;
}

/** Full TUI state shape. */
export interface TuiState {
  agentName: string;
  agentStatus: "running" | "stopped" | "error";
  agentVersion: string;

  messages: Message[];
  messageCount: number;

  events: EventLogEntry[];
  eventCount: number;
  isEventLogVisible: boolean;

  chatScrollOffset: number;
  eventScrollOffset: number;

  toolCallCount: number;
  errorCount: number;

  // Input state fields (Plan09)
  inputMode: "input" | "browse";
  inputText: string;
  inputHistory: string[];
  historyIndex: number;
  isPending: boolean;
}

/** All possible actions dispatched to the TUI reducer. */
export type TuiAction =
  | { type: "AGENT_STARTED"; payload: { name: string; version: string } }
  | { type: "AGENT_STOPPED" }
  | { type: "ADD_MESSAGE"; payload: Message }
  | { type: "APPEND_STREAM"; payload: { content: string; timestamp: number } }
  | { type: "FINALIZE_STREAM" }
  | { type: "ADD_EVENT"; payload: EventLogEntry }
  | { type: "TOGGLE_EVENT_LOG" }
  | { type: "SCROLL_CHAT"; payload: { delta: number } }
  | { type: "SCROLL_EVENT_LOG"; payload: { delta: number } }
  | { type: "SET_STATUS"; payload: "running" | "stopped" | "error" }
  // Plan09 — Input-related actions
  | { type: "SET_INPUT_MODE"; payload: "input" | "browse" }
  | { type: "SET_INPUT_TEXT"; payload: string }
  | { type: "HISTORY_PREV" }
  | { type: "HISTORY_NEXT" }
  | { type: "SUBMIT_INPUT"; payload: { text: string; timestamp: number } }
  | { type: "CLEAR_INPUT" }
  | { type: "SET_PENDING"; payload: boolean }
  | { type: "CLEAR_CHAT" };
