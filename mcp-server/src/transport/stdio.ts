/**
 * Stdio server transport — reads JSON-RPC from stdin, writes to stdout.
 * Used when OpenStarry agent is spawned as a child process by an MCP client.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createLogger } from "@openstarry/shared";
import type {
  McpServerTransport,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

const logger = createLogger("mcp-server:stdio");

export class StdioServerTransport implements McpServerTransport {
  private handler: ((req: JsonRpcRequest) => Promise<JsonRpcResponse>) | null =
    null;
  private readline: ReadlineInterface | null = null;
  private running = false;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.readline = createInterface({
      input: process.stdin,
      terminal: false,
    });

    this.readline.on("line", (line: string) => {
      this.buffer += line;
      void this.processBuffer();
    });

    logger.info("Stdio server transport started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    logger.info("Stdio server transport stopped");
  }

  onRequest(
    handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ): void {
    this.handler = handler;
  }

  sendNotification(method: string, params?: unknown): void {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.writeLine(JSON.stringify(notification));
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeLine(JSON.stringify(request));

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private async processBuffer(): Promise<void> {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      await this.processLine(line);
    }
  }

  private async processLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcRequest & JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest & JsonRpcResponse;
    } catch {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      };
      this.writeLine(JSON.stringify(errorResponse));
      return;
    }

    // Check if it's a response to a server→client request
    if ((msg.result !== undefined || msg.error !== undefined) && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Check if it's a client→server request (has method and id)
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      if (!this.handler) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "No handler registered" },
        };
        this.writeLine(JSON.stringify(errorResponse));
        return;
      }

      try {
        const response = await this.handler(msg as JsonRpcRequest);
        this.writeLine(JSON.stringify(response));
      } catch (err) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
        this.writeLine(JSON.stringify(errorResponse));
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method && (msg.id === undefined || msg.id === null)) {
      if (this.handler) {
        try {
          await this.handler(msg as JsonRpcRequest);
        } catch (err) {
          logger.error("Error handling notification", {
            method: msg.method,
            error: String(err),
          });
        }
      }
      return;
    }
  }

  private writeLine(data: string): void {
    process.stdout.write(data + "\n");
  }
}
