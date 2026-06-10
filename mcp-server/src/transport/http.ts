/**
 * HTTP server transport — accepts POST JSON-RPC requests via http.createServer.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "@openstarry/shared";
import type {
  McpServerTransport,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

const logger = createLogger("mcp-server:http");

export class HttpServerTransport implements McpServerTransport {
  private handler: ((req: JsonRpcRequest) => Promise<JsonRpcResponse>) | null =
    null;
  private server: Server | null = null;
  private readonly port: number;
  private readonly host: string;

  constructor(port = 3100, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.port, this.host, () => {
        logger.info("HTTP server transport started", {
          port: this.port,
          host: this.host,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        logger.info("HTTP server transport stopped");
        resolve();
      });
    });
  }

  onRequest(
    handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ): void {
    this.handler = handler;
  }

  sendNotification(_method: string, _params?: unknown): void {
    // HTTP has no persistent notification channel in Phase 1.
    // Server-initiated notifications are not supported over stateless HTTP.
  }

  async sendRequest(_method: string, _params?: unknown): Promise<unknown> {
    // HTTP bidirectional communication requires SSE or WebSocket (deferred to Plan15+).
    // For now, this is a no-op stub to satisfy the interface.
    throw new Error("HTTP server→client requests not yet implemented (requires SSE/WebSocket)");
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Only accept POST
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    let jsonRpcReq: JsonRpcRequest;
    try {
      jsonRpcReq = JSON.parse(body) as JsonRpcRequest;
    } catch {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorResponse));
      return;
    }

    if (!this.handler) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: jsonRpcReq.id,
        error: { code: -32603, message: "No handler registered" },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorResponse));
      return;
    }

    try {
      const response = await this.handler(jsonRpcReq);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: jsonRpcReq.id,
        error: {
          code: -32603,
          message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorResponse));
    }
  }
}
