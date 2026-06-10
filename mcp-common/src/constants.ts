/**
 * Shared MCP protocol constants.
 */

/** MCP protocol version supported by this implementation. */
export const PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC 2.0 standard error codes. */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * FROZEN CONSTANT v0.12.0 (Extended)
 * MCP-specific error codes for sampling/logging/roots.
 */
export const McpErrorCode = {
  // ─── Sampling Errors ───
  /** Sampling not supported by client (capability not declared) */
  SAMPLING_NOT_SUPPORTED: -32001,
  /** Sampling depth limit exceeded (anti-recursion guard) */
  SAMPLING_DEPTH_EXCEEDED: -32002,
  /** No suitable LLM provider available for model hint */
  SAMPLING_PROVIDER_UNAVAILABLE: -32003,

  // ─── Roots Errors ───
  /** Roots not supported by client (capability not declared) */
  ROOTS_NOT_SUPPORTED: -32004,

  // ─── Logging Errors ───
  /** Invalid log level in logging/setLevel request */
  LOGGING_INVALID_LEVEL: -32005,
} as const;
