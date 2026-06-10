/**
 * Logging handler — Server sends structured logs to client.
 * Routes logs to OpenStarry logger and event bus.
 */
import type { IPluginContext } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import { createLogger, type Logger } from "@openstarry/shared";
import type { McpLogMessage, McpLogLevel } from "@openstarry-plugin/mcp-common";

export class LoggingHandler {
  private logger: Logger;
  private logRateLimiter = { count: 0, resetAt: Date.now() + 1000 };
  private maxLogsPerSecond = 100;
  private maxLogLength = 2000;

  constructor(
    private ctx: IPluginContext,
    private serverName: string,
  ) {
    this.logger = createLogger(`mcp-server:${serverName}`);
  }

  handleLogNotification(params: McpLogMessage): void {
    // Rate limit check
    const now = Date.now();
    if (now > this.logRateLimiter.resetAt) {
      this.logRateLimiter = { count: 1, resetAt: now + 1000 };
    } else if (this.logRateLimiter.count >= this.maxLogsPerSecond) {
      // Drop log silently
      return;
    } else {
      this.logRateLimiter.count++;
    }

    const level = this.mapMcpLevel(params.level);
    const loggerName = params.logger ?? "default";

    // Sanitize message data BEFORE logging and event emission
    const message = this.sanitizeLogData(params.data);

    // 1. Route to OpenStarry logger (with sanitized message)
    this.logger[level](`[${loggerName}] ${message}`);

    // 2. Emit event for TUI dashboard (with sanitized message)
    this.ctx.bus.emit({
      type: AgentEventType.MCP_SERVER_LOG,
      timestamp: params.timestamp ? new Date(params.timestamp).getTime() : Date.now(),
      payload: {
        serverName: this.serverName,
        level: params.level,
        logger: params.logger,
        data: message,
      },
    });
  }

  /**
   * Sanitize log message data to prevent injection attacks.
   * Defense-in-depth measures:
   * 1. Strip ANSI escape sequences (terminal manipulation)
   * 2. Remove control characters (except tab, newline, carriage return)
   * 3. Normalize whitespace (collapse multiple spaces)
   * 4. Truncate to maximum length (prevent DoS)
   *
   * @param data - Raw log data from MCP server
   * @returns Sanitized string safe for logging and display
   */
  private sanitizeLogData(data: unknown): string {
    // Convert to string
    let message = typeof data === "string" ? data : JSON.stringify(data);

    // 1. Strip ANSI escape sequences (e.g., \x1b[31m for red text)
    message = message.replace(/\x1b\[[0-9;]*m/g, "");

    // 2. Remove control characters (0x00-0x1F, 0x7F), except tab/newline/carriage return
    message = message.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");

    // 3. Normalize whitespace (collapse multiple spaces, trim)
    message = message.replace(/\s+/g, " ").trim();

    // 4. Truncate to max length
    if (message.length > this.maxLogLength) {
      message = message.slice(0, this.maxLogLength) + "... (truncated)";
    }

    return message;
  }

  private mapMcpLevel(mcpLevel: McpLogLevel): "debug" | "info" | "warn" | "error" {
    switch (mcpLevel) {
      case "debug":
        return "debug";
      case "info":
      case "notice":
        return "info";
      case "warning":
        return "warn";
      case "error":
      case "critical":
      case "alert":
      case "emergency":
        return "error";
    }
  }
}
