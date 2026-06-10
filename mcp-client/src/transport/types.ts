/**
 * MCP Transport abstraction — JSON-RPC 2.0 communication layer.
 */

export type { JsonRpcRequest, JsonRpcResponse } from "@openstarry-plugin/mcp-common";

/**
 * FROZEN INTERFACE
 * Authentication provider for MCP transports
 */
export interface McpTransportAuth {
  /**
   * Get current valid access token.
   * Returns null if no token or token expired and refresh failed.
   */
  getToken(): Promise<string | null>;

  /**
   * Handle 401 Unauthorized response.
   * Attempt token refresh, return true if retry recommended.
   */
  onUnauthorized(): Promise<boolean>;
}

/**
 * FROZEN INTERFACE v0.12.0
 * MCP Transport abstraction — JSON-RPC 2.0 bidirectional communication layer.
 * Extends existing unidirectional transport to support server→client requests.
 */
export interface McpTransport {
  // ─── Existing methods (unchanged) ───
  connect(): Promise<void>;
  send(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
  onMessage?(handler: (method: string, params: unknown) => void): void;

  // ─── NEW: Bidirectional support ───

  /**
   * Register handler for incoming JSON-RPC requests from server.
   * Handler must return a JSON-serializable result or throw an error.
   * @param handler - Async function (method, params) => result
   */
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;

  /**
   * Register handler for incoming JSON-RPC notifications from server.
   * Notifications are fire-and-forget (no response expected).
   * @param handler - Function (method, params) => void
   */
  onNotification(handler: (method: string, params: unknown) => void): void;
}
