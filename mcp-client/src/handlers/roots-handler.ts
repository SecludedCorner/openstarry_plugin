/**
 * Roots handler — Server queries client filesystem boundaries.
 */
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import type { IPluginContext } from "@openstarry/sdk";
import { AgentEventType, getSessionConfig } from "@openstarry/sdk";
import type { McpRootsListResult, McpRoot } from "@openstarry-plugin/mcp-common";
import type { McpTransport } from "../transport/types.js";

export class RootsHandler {
  constructor(
    private ctx: IPluginContext,
    private serverName: string,
  ) {}

  async handleRootsListRequest(sessionId?: string): Promise<McpRootsListResult> {
    // 1. Try to get session-level allowedPaths
    const session = sessionId ? this.ctx.sessions.get(sessionId) : undefined;
    const sessionConfig = session ? getSessionConfig(session.metadata) : undefined;

    // 2. Fallback chain: session config → agent config → workingDirectory
    const allowedPaths =
      sessionConfig?.allowedPaths ??
      (this.ctx.config.allowedPaths as string[] | undefined) ??
      [this.ctx.workingDirectory];

    // 3. Convert to MCP roots
    const roots: McpRoot[] = allowedPaths.map((path) => ({
      uri: pathToFileURL(path).href,
      name: basename(path) || "Root",
    }));

    this.ctx.bus.emit({
      type: AgentEventType.MCP_ROOTS_REQUESTED,
      timestamp: Date.now(),
      payload: { serverName: this.serverName, rootCount: roots.length },
    });

    return { roots };
  }

  setupListChangedNotification(transport: McpTransport): void {
    // Emit notification when session config changes
    // Note: This is a stub for future implementation
    this.ctx.bus.on("session:config_updated", () => {
      transport.notify("notifications/roots/listChanged");
      this.ctx.bus.emit({
        type: AgentEventType.MCP_ROOTS_CHANGED,
        timestamp: Date.now(),
        payload: {
          sessionId: "default",
          rootCount: 1,
        },
      });
    });
  }
}
