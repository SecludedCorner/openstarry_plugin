/**
 * StdioTransport — spawn child process, JSON-RPC 2.0 over stdin/stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "@openstarry/shared";
import type { McpTransport, JsonRpcRequest, JsonRpcResponse } from "./types.js";

const logger = createLogger("mcp-stdio");

export class StdioTransport implements McpTransport {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private messageHandler?: (method: string, params: unknown) => void;
  private requestHandler?: (method: string, params: unknown) => Promise<unknown>;
  private notificationHandler?: (method: string, params: unknown) => void;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    const mergedEnv = { ...process.env, ...this.env };

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
      shell: process.platform === "win32",
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.processBuffer();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        logger.debug("Server stderr", { text });
      }
    });

    this.process.on("error", (err) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pending.clear();
    });

    this.process.on("exit", (code) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      throw new Error("MCP transport not connected");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as Record<string, unknown> | undefined,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(line, "utf-8");
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;

    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params: params as Record<string, unknown> | undefined,
    };

    const line = JSON.stringify(notification) + "\n";
    this.process.stdin.write(line, "utf-8");
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }
    this.pending.clear();
  }

  onMessage(handler: (method: string, params: unknown) => void): void {
    this.messageHandler = handler;
  }

  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  private async processBuffer(): Promise<void> {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse & JsonRpcRequest & { method?: string; params?: unknown };

        // Check if it's a response (has result or error, and id)
        if ((msg.result !== undefined || msg.error !== undefined) && msg.id !== undefined && msg.id !== null) {
          // Response to a pending client→server request
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if (msg.method && msg.id !== undefined && msg.id !== null) {
          // Server→client request (has method and id)
          if (this.requestHandler) {
            try {
              const result = await this.requestHandler(msg.method, msg.params ?? {});
              const response: JsonRpcResponse = {
                jsonrpc: "2.0",
                id: msg.id,
                result,
              };
              this.process?.stdin?.write(JSON.stringify(response) + "\n", "utf-8");
            } catch (err) {
              const errorResponse: JsonRpcResponse = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -32603,
                  message: err instanceof Error ? err.message : String(err),
                },
              };
              this.process?.stdin?.write(JSON.stringify(errorResponse) + "\n", "utf-8");
            }
          }
        } else if (msg.method && (msg.id === undefined || msg.id === null)) {
          // Server→client notification (has method, no id)
          if (this.notificationHandler) {
            this.notificationHandler(msg.method, msg.params ?? {});
          } else if (this.messageHandler) {
            // Backward compatibility
            this.messageHandler(msg.method, msg.params ?? {});
          }
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }
}
