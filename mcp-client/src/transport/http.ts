/**
 * StreamableHttpTransport — POST JSON-RPC 2.0 over HTTP.
 */
import { createLogger } from "@openstarry/shared";
import type { McpTransport, McpTransportAuth, JsonRpcRequest, JsonRpcResponse } from "./types.js";

const logger = createLogger("mcp-http");

export class StreamableHttpTransport implements McpTransport {
  private nextId = 1;
  private abortController: AbortController | null = null;
  private requestHandler?: (method: string, params: unknown) => Promise<unknown>;
  private notificationHandler?: (method: string, params: unknown) => void;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private auth?: McpTransportAuth,
  ) {}

  async connect(): Promise<void> {
    this.abortController = new AbortController();
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    return this.sendWithRetry(method, params, false);
  }

  private async sendWithRetry(method: string, params: unknown | undefined, isRetry: boolean): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as Record<string, unknown> | undefined,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      // Build headers with optional auth
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.headers,
      };

      // Inject OAuth Bearer token if available
      if (this.auth) {
        const token = await this.auth.getToken();
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
      }

      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle 401 Unauthorized with token refresh + retry
      if (response.status === 401 && this.auth && !isRetry) {
        logger.debug("Received 401, attempting token refresh");
        const shouldRetry = await this.auth.onUnauthorized();
        if (shouldRetry) {
          logger.debug("Token refreshed, retrying request");
          return this.sendWithRetry(method, params, true);
        }
        throw new Error("HTTP 401: Unauthorized (token refresh failed)");
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as JsonRpcResponse;

      if (result.error) {
        throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
      }

      return result.result;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("MCP HTTP request timed out (30s)");
      }
      throw err;
    }
  }

  notify(method: string, params?: unknown): void {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params: params as Record<string, unknown> | undefined,
    };

    fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(notification),
      signal: this.abortController?.signal,
    }).catch((err) => {
      logger.debug("Notification send failed", { method, error: String(err) });
    });
  }

  async close(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }
}
