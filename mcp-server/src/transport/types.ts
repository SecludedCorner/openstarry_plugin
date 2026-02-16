/**
 * Server-side MCP transport types — JSON-RPC 2.0 communication layer.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "@openstarry-plugin/mcp-common";
export type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "@openstarry-plugin/mcp-common";

/**
 * FROZEN INTERFACE v0.12.0
 * Server-side transport abstraction for MCP protocol.
 * Extends existing passive server to support server→client requests.
 */
export interface McpServerTransport {
  // ─── Existing methods (unchanged) ───
  /** Start accepting connections and processing requests. */
  start(): Promise<void>;

  /** Stop accepting connections gracefully. */
  stop(): Promise<void>;

  /** Register a handler for incoming JSON-RPC requests. */
  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void;

  /**
   * Send a JSON-RPC notification to the client (fire-and-forget).
   * Used for: logging, roots/listChanged, resources/updated.
   */
  sendNotification(method: string, params?: unknown): void;

  // ─── NEW: Request capability ───

  /**
   * Send a JSON-RPC request to the client and await response.
   * Used for: sampling/createMessage, roots/list (if server-initiated).
   * @param method - JSON-RPC method name
   * @param params - Method parameters
   * @returns Promise resolving to JSON-RPC result
   * @throws Error if client returns JSON-RPC error response
   */
  sendRequest(method: string, params?: unknown): Promise<unknown>;
}
