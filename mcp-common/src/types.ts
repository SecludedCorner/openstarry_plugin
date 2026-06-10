/**
 * Shared MCP protocol types — JSON-RPC 2.0, tool, and prompt definitions.
 *
 * Used by both @openstarry-plugin/mcp-client and @openstarry-plugin/mcp-server.
 */

// ─── JSON-RPC 2.0 ───

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ─── MCP Tool Types ───

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string };

// ─── MCP Prompt Types ───

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptResult {
  description?: string;
  messages: Array<{ role: "user" | "assistant"; content: McpContent }>;
}

// ─── MCP Resource Types ───

/**
 * FROZEN INTERFACE
 * MCP Resource definition (MCP protocol 2024-11-05)
 */
export interface McpResourceInfo {
  /** Resource identifier (human-readable, unique within server) */
  name: string;
  /** Resource URI (e.g., file:///path, openstarry://command/ls) */
  uri: string;
  /** Human-readable description */
  description?: string;
  /** MIME type hint (e.g., text/plain, application/json) */
  mimeType?: string;
}

/**
 * FROZEN INTERFACE
 * MCP resource read result (MCP protocol 2024-11-05)
 */
export interface McpResourceResult {
  /** Resource content (array of text/image/resource content) */
  contents: McpContent[];
}

// ─── MCP Capabilities ───

/**
 * FROZEN INTERFACE v0.12.0 (Extended)
 * MCP Capabilities declaration for initialize handshake.
 */
export interface McpCapabilities {
  // ─── Existing (unchanged) ───
  tools?: { listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };

  // ─── NEW: Sampling ───
  /**
   * Client declares sampling capability (can invoke LLM on server's behalf).
   * If present, server may send sampling/createMessage requests.
   */
  sampling?: {};

  // ─── NEW: Roots ───
  /**
   * Client declares roots capability (can provide filesystem boundaries).
   * If listChanged: true, client will send notifications/roots/listChanged.
   */
  roots?: { listChanged?: boolean };

  // ─── NEW: Logging ───
  /**
   * Server declares logging capability (will send log notifications).
   * If present, client may call logging/setLevel to adjust verbosity.
   */
  logging?: {};
}

// ─── MCP Sampling Types ───

/**
 * FROZEN INTERFACE v0.12.0
 * MCP Sampling — Server requests LLM completion from client.
 * Spec: https://spec.modelcontextprotocol.io/specification/2024-11-05/client/sampling
 */

/** Sampling message content */
export interface SamplingMessage {
  role: "user" | "assistant" | "system";
  content: McpContent;
}

/** Model selection hints for sampling (MCP spec Section 5.6.2) */
export interface ModelPreferences {
  /** Model name hints (e.g., ["claude-3-opus", "gpt-4"]) */
  hints?: Array<{ name?: string }>;
  /** Cost priority [0, 1] — 0: minimize cost, 1: ignore cost */
  costPriority?: number;
  /** Speed priority [0, 1] — 0: minimize latency, 1: ignore latency */
  speedPriority?: number;
  /** Intelligence priority [0, 1] — 0: basic model, 1: most capable */
  intelligencePriority?: number;
}

/** Sampling request params (MCP spec Section 5.6.1) */
export interface SamplingRequest {
  /** Conversation messages (server provides context) */
  messages: SamplingMessage[];
  /** Model selection preferences */
  modelPreferences?: ModelPreferences;
  /** System prompt override */
  systemPrompt?: string;
  /** Context inclusion hint: "none" | "thisServer" | "allServers" */
  includeContext?: string;
  /** Temperature [0, 2] */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Server-provided metadata (for logging/debugging) */
  metadata?: Record<string, unknown>;
}

/** Sampling response result (MCP spec Section 5.6.3) */
export interface SamplingResponse {
  /** Assistant role (always "assistant") */
  role: "assistant";
  /** Generated content */
  content: McpContent;
  /** Actual model used (e.g., "claude-3-5-sonnet-20241022") */
  model: string;
  /** Stop reason: "end_turn" | "stop_sequence" | "max_tokens" */
  stopReason?: string;
}

// ─── MCP Logging Types ───

/**
 * FROZEN INTERFACE v0.12.0
 * MCP Logging — Server sends structured logs to client.
 * Spec: https://spec.modelcontextprotocol.io/specification/2024-11-05/server/logging
 */

/** MCP log levels (8 levels per MCP spec Section 5.8.1) */
export type McpLogLevel =
  | "debug"      // Verbose debugging info
  | "info"       // Informational messages
  | "notice"     // Significant events
  | "warning"    // Warning messages
  | "error"      // Error messages
  | "critical"   // Critical failures
  | "alert"      // Action required immediately
  | "emergency"; // System unusable

/** Log message notification payload (MCP spec Section 5.8.2) */
export interface McpLogMessage {
  /** Log level */
  level: McpLogLevel;
  /** Logger name (e.g., "mcp-server-github", "filesystem") */
  logger?: string;
  /** Log message data (string or structured object) */
  data: unknown;
  /** ISO 8601 timestamp (optional, client may add if missing) */
  timestamp?: string;
}

/** SetLevel request params (MCP spec Section 5.8.3) */
export interface McpSetLevelRequest {
  /** Minimum log level server should send */
  level: McpLogLevel;
}

// ─── MCP Roots Types ───

/**
 * FROZEN INTERFACE v0.12.0
 * MCP Roots — Client declares filesystem boundaries to server.
 * Spec: https://spec.modelcontextprotocol.io/specification/2024-11-05/client/roots
 */

/** Root definition (MCP spec Section 5.7.1) */
export interface McpRoot {
  /** Root URI (e.g., "file:///workspace/myproject/") */
  uri: string;
  /** Human-readable name (e.g., "Project Root") */
  name?: string;
}

/** Roots list response (MCP spec Section 5.7.2) */
export interface McpRootsListResult {
  /** Array of root URIs */
  roots: McpRoot[];
}
