/**
 * @openstarry-plugin/mcp-common
 *
 * Shared types and constants for the MCP protocol (client + server).
 */

export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  McpToolInfo,
  McpToolResult,
  McpContent,
  McpPromptInfo,
  McpPromptResult,
  McpCapabilities,
  McpResourceInfo,
  McpResourceResult,
  // NEW: Sampling types
  SamplingMessage,
  SamplingRequest,
  SamplingResponse,
  ModelPreferences,
  // NEW: Logging types
  McpLogLevel,
  McpLogMessage,
  McpSetLevelRequest,
  // NEW: Roots types
  McpRoot,
  McpRootsListResult,
} from "./types.js";

export { PROTOCOL_VERSION, JsonRpcErrorCode, McpErrorCode } from "./constants.js";
