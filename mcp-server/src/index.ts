/**
 * MCP Server Plugin — exposes OpenStarry tools and guides to external MCP clients.
 *
 * Five Aggregates mapping: IListener (受蘊) — receives external JSON-RPC requests.
 */

import type { IPlugin, IPluginContext, IListener, SlashCommand } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import { createLogger } from "@openstarry/shared";
import type { McpServerTransport } from "./transport/types.js";
import { StdioServerTransport } from "./transport/stdio.js";
import { HttpServerTransport } from "./transport/http.js";
import { createMcpJsonRpcHandler } from "./handler.js";

const logger = createLogger("mcp-server");

/** Plugin configuration for the MCP server. */
export interface McpServerConfig {
  /** Server name for handshake (exposed in initialize response). */
  name: string;
  /** Server version for handshake. */
  version: string;
  /** Transport type: "stdio" or "http". */
  transport: "stdio" | "http";
  /** HTTP port (default 3100, only used if transport === "http"). */
  port?: number;
  /** HTTP host (default "127.0.0.1", only used if transport === "http"). */
  host?: string;
  /** Tool IDs to expose via MCP. "*" = all (default). */
  exposedTools?: string[] | "*";
  /** Guide IDs to expose via MCP prompts. "*" = all (default). */
  exposedGuides?: string[] | "*";
  /**
   * FROZEN CONFIG FIELD
   * SlashCommand names to expose as MCP resources. "*" = all (default: undefined = none).
   * Format: command.name → openstarry://command/{name}
   */
  exposedResources?: string[] | "*";
}

function parseConfig(raw: Record<string, unknown>): McpServerConfig {
  const name = raw.name as string | undefined;
  const version = raw.version as string | undefined;

  if (!name || typeof name !== "string") {
    throw new Error("MCP server config requires 'name' (string)");
  }
  if (!version || typeof version !== "string") {
    throw new Error("MCP server config requires 'version' (string)");
  }

  const transport = (raw.transport as string) ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(
      `MCP server config 'transport' must be "stdio" or "http", got "${transport}"`,
    );
  }

  return {
    name,
    version,
    transport,
    port: typeof raw.port === "number" ? raw.port : 3100,
    host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
    exposedTools:
      raw.exposedTools === undefined
        ? "*"
        : (raw.exposedTools as string[] | "*"),
    exposedGuides:
      raw.exposedGuides === undefined
        ? "*"
        : (raw.exposedGuides as string[] | "*"),
    exposedResources:
      raw.exposedResources === undefined
        ? undefined
        : (raw.exposedResources as string[] | "*"),
  };
}

function createTransport(config: McpServerConfig): McpServerTransport {
  if (config.transport === "http") {
    return new HttpServerTransport(config.port, config.host);
  }
  return new StdioServerTransport();
}

/** Create the MCP Server plugin. */
export function createMcpServerPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/mcp-server",
      version: "0.4.0",
      description:
        "Expose OpenStarry tools and guides to external MCP clients via JSON-RPC 2.0",
      skandha: 'rupa' as const,
    },

    async factory(ctx: IPluginContext) {
      const config = parseConfig(ctx.config);
      const transport = createTransport(config);

      // Create a command registry for resource exposure
      const commandRegistry = new Map<string, SlashCommand>();

      const handler = createMcpJsonRpcHandler(config, ctx, commandRegistry);

      transport.onRequest(handler);

      const listener: IListener = {
        skandha: 'rupa' as const,
        id: `mcp-server:${config.name}`,
        name: `MCP Server (${config.transport})`,
        async start() {
          logger.info("Starting MCP server", {
            name: config.name,
            transport: config.transport,
            ...(config.transport === "http"
              ? { port: config.port, host: config.host }
              : {}),
          });
          await transport.start();
        },
        async stop() {
          logger.info("Stopping MCP server", { name: config.name });
          ctx.bus.emit({
            type: AgentEventType.MCP_CLIENT_DISCONNECTED,
            timestamp: Date.now(),
            payload: {
              serverName: config.name,
              transport: config.transport,
              reason: "server_shutdown",
            },
          });
          await transport.stop();
        },
      };

      const commands: SlashCommand[] = [
        {
          name: "mcp-server-status",
          description: "Show MCP server status",
          async execute(_args: string, _ctx: IPluginContext): Promise<string> {
            const toolCount = ctx.tools
              ? filterExposed(ctx.tools.list(), config.exposedTools).length
              : 0;
            const guideCount = ctx.guides
              ? filterExposed(ctx.guides.list(), config.exposedGuides).length
              : 0;
            const resourceCount = Array.from(commandRegistry.values()).length;
            const exposedResourceCount = filterExposed(
              Array.from(commandRegistry.values()),
              config.exposedResources,
            ).length;
            return [
              `MCP Server: ${config.name} v${config.version}`,
              `Transport: ${config.transport}${config.transport === "http" ? ` (${config.host}:${config.port})` : ""}`,
              `Exposed tools: ${toolCount}`,
              `Exposed prompts: ${guideCount}`,
              `Exposed resources: ${exposedResourceCount}`,
            ].join("\n");
          },
        },
        {
          name: "mcp-server-tools",
          description: "List tools exposed via MCP server",
          async execute(_args: string, _ctx: IPluginContext): Promise<string> {
            if (!ctx.tools) return "Tools not available";
            const tools = filterExposed(ctx.tools.list(), config.exposedTools);
            if (tools.length === 0) return "No tools exposed";
            return tools.map((t) => `- ${t.id}: ${t.description}`).join("\n");
          },
        },
        {
          name: "mcp-server-prompts",
          description: "List prompts exposed via MCP server",
          async execute(_args: string, _ctx: IPluginContext): Promise<string> {
            if (!ctx.guides) return "Guides not available";
            const guides = filterExposed(
              ctx.guides.list(),
              config.exposedGuides,
            );
            if (guides.length === 0) return "No prompts exposed";
            return guides.map((g) => `- ${g.id}: ${g.name}`).join("\n");
          },
        },
        {
          name: "mcp-server-resources",
          description: "List resources exposed via MCP server",
          async execute(_args: string, _ctx: IPluginContext): Promise<string> {
            const allCommands = Array.from(commandRegistry.values());
            const exposed = filterExposed(allCommands, config.exposedResources);
            if (exposed.length === 0) return "No resources exposed";
            return exposed.map((c) => `- ${c.name}: ${c.description ?? "(no description)"}`).join("\n");
          },
        },
      ];

      // Register management commands in the registry
      for (const cmd of commands) {
        commandRegistry.set(cmd.name, cmd);
      }

      return {
        listeners: [listener],
        commands,
        async dispose() {
          await transport.stop();
        },
      };
    },
  };
}

function filterExposed<T extends { id?: string; name?: string }>(
  items: T[],
  filter: string[] | "*" | undefined,
): T[] {
  if (filter === "*" || filter === undefined) {
    return items;
  }
  return items.filter((item) => {
    const identifier = item.id ?? item.name;
    return identifier && filter.includes(identifier);
  });
}

export { StdioServerTransport } from "./transport/stdio.js";
export { HttpServerTransport } from "./transport/http.js";
export { createMcpJsonRpcHandler } from "./handler.js";
export type { McpServerTransport } from "./transport/types.js";
export type { JsonRpcRequest, JsonRpcResponse } from "@openstarry-plugin/mcp-common";
