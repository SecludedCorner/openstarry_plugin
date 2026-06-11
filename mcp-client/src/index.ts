/**
 * @openstarry-plugin/mcp-client
 *
 * Connects to external MCP servers and imports their tools and prompts.
 */
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ITool,
  SlashCommand,
} from "@openstarry/sdk";
import { AgentEventType, McpError, ErrorCode, ConfigError } from "@openstarry/sdk";
import { createLogger } from "@openstarry/shared";
import { McpClientImpl, type McpCapabilities } from "./client.js";
import { StdioTransport } from "./transport/stdio.js";
import { StreamableHttpTransport } from "./transport/http.js";
import { jsonSchemaToZod } from "./schema.js";
import { createMcpToolBridge } from "./bridges/tool-bridge.js";
import { createMcpPromptBridge } from "./bridges/prompt-bridge.js";
import { createMcpResourceBridge } from "./bridges/resource-bridge.js";
import type { McpTransport, McpTransportAuth } from "./transport/types.js";
import { EncryptedTokenStorage } from "./auth/token-storage.js";
import type { McpOAuthConfig } from "./auth/types.js";
import { SamplingHandler } from "./handlers/sampling-handler.js";
import { LoggingHandler } from "./handlers/logging-handler.js";
import { RootsHandler } from "./handlers/roots-handler.js";
import type { SamplingRequest } from "@openstarry-plugin/mcp-common";

const logger = createLogger("mcp-client");

// ─── Config Types ───

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth 2.1 configuration (HTTP transport only) */
  oauth?: McpOAuthConfig;
}

export interface McpClientConfig {
  servers: McpServerConfig[];
}

// ─── Helpers ───

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function extractDepthFromContext(metadata?: Record<string, unknown>): number {
  if (metadata && typeof metadata.depth === "number") {
    return metadata.depth;
  }
  return 0;
}

function createTransport(config: McpServerConfig, ctx: IPluginContext, auth?: McpTransportAuth): McpTransport {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new ConfigError(
        `MCP server "${config.name}": stdio transport requires "command"`,
        { code: ErrorCode.CONFIG_VALIDATION_ERROR },
      );
    }
    return new StdioTransport(config.command, config.args ?? [], config.env ?? {});
  }

  if (config.transport === "http") {
    if (!config.url) {
      throw new ConfigError(
        `MCP server "${config.name}": http transport requires "url"`,
        { code: ErrorCode.CONFIG_VALIDATION_ERROR },
      );
    }
    return new StreamableHttpTransport(config.url, config.headers ?? {}, auth);
  }

  throw new ConfigError(
    `MCP server "${config.name}": unknown transport "${config.transport}"`,
    { code: ErrorCode.CONFIG_VALIDATION_ERROR },
  );
}

// ─── Slash Commands ───

function createStatusCommand(clients: McpClientImpl[]): SlashCommand {
  return {
    name: "mcp-status",
    description: "List all MCP server connection states",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      if (clients.length === 0) {
        return "No MCP servers configured.";
      }
      const lines = clients.map((c) => {
        const status = c.isConnected ? "connected" : "disconnected";
        return `  ${c.name}: ${status}`;
      });
      return `MCP Server Status:\n${lines.join("\n")}`;
    },
  };
}

function createToolsCommand(clients: McpClientImpl[]): SlashCommand {
  return {
    name: "mcp-tools",
    description: "List all tools from connected MCP servers",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      if (clients.length === 0) {
        return "No MCP servers configured.";
      }
      const sections: string[] = [];
      for (const client of clients) {
        if (!client.isConnected) {
          sections.push(`  ${client.name}: (disconnected)`);
          continue;
        }
        try {
          const tools = await client.listTools();
          if (tools.length === 0) {
            sections.push(`  ${client.name}: (no tools)`);
          } else {
            const toolLines = tools.map(
              (t) => `    ${client.name}/${t.name} — ${t.description ?? "(no description)"}`,
            );
            sections.push(`  ${client.name} (${tools.length} tools):\n${toolLines.join("\n")}`);
          }
        } catch {
          sections.push(`  ${client.name}: (query failed)`);
        }
      }
      return `MCP Tools:\n${sections.join("\n\n")}`;
    },
  };
}

function createPromptsCommand(clients: McpClientImpl[]): SlashCommand {
  return {
    name: "mcp-prompts",
    description: "List all prompts from connected MCP servers",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      if (clients.length === 0) {
        return "No MCP servers configured.";
      }
      const sections: string[] = [];
      for (const client of clients) {
        if (!client.isConnected) {
          sections.push(`  ${client.name}: (disconnected)`);
          continue;
        }
        try {
          const prompts = await client.listPrompts();
          if (prompts.length === 0) {
            sections.push(`  ${client.name}: (no prompts)`);
          } else {
            const promptLines = prompts.map(
              (p) => `    /mcp:${client.name}:${p.name} — ${p.description ?? "(no description)"}`,
            );
            sections.push(`  ${client.name} (${prompts.length} prompts):\n${promptLines.join("\n")}`);
          }
        } catch {
          sections.push(`  ${client.name}: (query failed)`);
        }
      }
      return `MCP Prompts:\n${sections.join("\n\n")}`;
    },
  };
}

function createResourcesCommand(clients: McpClientImpl[]): SlashCommand {
  return {
    name: "mcp-resources",
    description: "List all resources from connected MCP servers",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      if (clients.length === 0) {
        return "No MCP servers configured.";
      }
      const sections: string[] = [];
      for (const client of clients) {
        if (!client.isConnected) {
          sections.push(`  ${client.name}: (disconnected)`);
          continue;
        }
        try {
          const resources = await client.listResources();
          if (resources.length === 0) {
            sections.push(`  ${client.name}: (no resources)`);
          } else {
            const resourceLines = resources.map(
              (r) => `    /mcp-resource:${client.name}:${r.name} — ${r.description ?? r.uri}`,
            );
            sections.push(`  ${client.name} (${resources.length} resources):\n${resourceLines.join("\n")}`);
          }
        } catch {
          sections.push(`  ${client.name}: (query failed)`);
        }
      }
      return `MCP Resources:\n${sections.join("\n\n")}`;
    },
  };
}

function createLogLevelCommand(
  clients: Array<{ name: string; transport: McpTransport }>,
): SlashCommand {
  return {
    name: "mcp-loglevel",
    description: "Set MCP server log level (debug, info, notice, warning, error, critical, alert, emergency)",
    async execute(args: string, ctx: IPluginContext): Promise<string> {
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) {
        return "Usage: /mcp-loglevel <server-name> <level>";
      }
      const [serverName, level] = parts;
      const client = clients.find((c) => c.name === serverName);
      if (!client) {
        return `Server not found: ${serverName}`;
      }

      try {
        await client.transport.send("logging/setLevel", { level });
        ctx.bus.emit({
          type: AgentEventType.MCP_LOG_LEVEL_CHANGED,
          timestamp: Date.now(),
          payload: { serverName, level },
        });
        return `Log level set to ${level} for ${serverName}`;
      } catch (err) {
        return `Failed to set log level: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ─── Plugin Factory ───

export function createMcpClientPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/mcp-client",
      version: "0.4.0",
      description: "MCP protocol client for importing external tools and prompts",
      author: "OpenStarry Team",
      skandha: 'rupa' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as unknown as McpClientConfig;
      if (!config?.servers || config.servers.length === 0) {
        logger.info("No MCP servers configured");
        return { commands: [createStatusCommand([]), createToolsCommand([]), createPromptsCommand([]), createResourcesCommand([])] };
      }

      const tools: ITool[] = [];
      const commands: SlashCommand[] = [];
      const clients: McpClientImpl[] = [];
      const clientTransports: Array<{ name: string; transport: McpTransport }> = [];

      for (const serverConfig of config.servers) {
        try {
          // Setup OAuth if configured (HTTP transport only)
          let auth: McpTransportAuth | undefined;
          if (serverConfig.transport === "http" && serverConfig.oauth?.enabled) {
            const tokenStorage = new EncryptedTokenStorage(ctx, serverConfig.name, serverConfig.oauth);
            auth = tokenStorage; // EncryptedTokenStorage implements McpTransportAuth
          }

          const transport = createTransport(serverConfig, ctx, auth);
          const client = new McpClientImpl(serverConfig.name, transport);

          // Register bidirectional handlers BEFORE connecting
          const samplingHandler = new SamplingHandler(ctx, serverConfig.name);
          const loggingHandler = new LoggingHandler(ctx, serverConfig.name);
          const rootsHandler = new RootsHandler(ctx, serverConfig.name);

          transport.onRequest(async (method, params) => {
            if (method === "sampling/createMessage") {
              const req = params as SamplingRequest;
              const traceId = generateTraceId();
              const depth = extractDepthFromContext(req.metadata);
              return samplingHandler.handleSamplingRequest(req, traceId, depth + 1);
            }
            if (method === "roots/list") {
              return rootsHandler.handleRootsListRequest();
            }
            throw new Error(`Unsupported server request: ${method}`);
          });

          transport.onNotification((method, params) => {
            if (method === "notifications/message") {
              loggingHandler.handleLogNotification(params as any);
            }
          });

          // Setup roots change notification
          rootsHandler.setupListChangedNotification(transport);

          await client.connect();
          clients.push(client);
          clientTransports.push({ name: serverConfig.name, transport });

          // List and bridge tools
          const mcpTools = await client.listTools();
          for (const toolInfo of mcpTools) {
            const schema = jsonSchemaToZod(toolInfo.inputSchema as Record<string, unknown>);
            const tool = createMcpToolBridge(
              serverConfig.name,
              toolInfo.name,
              toolInfo.description ?? `MCP tool from ${serverConfig.name}`,
              schema,
              client,
            );
            tools.push(tool);

            ctx.bus.emit({
              type: AgentEventType.MCP_TOOL_REGISTERED,
              timestamp: Date.now(),
              payload: { serverName: serverConfig.name, toolName: toolInfo.name, fullId: tool.id },
            });
          }

          // List and bridge prompts
          const mcpPrompts = await client.listPrompts();
          for (const promptInfo of mcpPrompts) {
            const command = createMcpPromptBridge(
              serverConfig.name,
              promptInfo.name,
              promptInfo.description ?? `MCP prompt from ${serverConfig.name}`,
              client,
            );
            commands.push(command);

            ctx.bus.emit({
              type: AgentEventType.MCP_PROMPT_REGISTERED,
              timestamp: Date.now(),
              payload: { serverName: serverConfig.name, promptName: promptInfo.name, commandName: command.name },
            });
          }

          // List and bridge resources
          const mcpResources = await client.listResources();
          for (const resourceInfo of mcpResources) {
            const command = createMcpResourceBridge(
              serverConfig.name,
              resourceInfo,
              client,
            );
            commands.push(command);

            // Use generic event (MCP_RESOURCE_REGISTERED not in SDK yet)
            ctx.bus.emit({
              type: "mcp:resource_registered",
              timestamp: Date.now(),
              payload: { serverName: serverConfig.name, resourceName: resourceInfo.name, commandName: command.name },
            });
          }

          ctx.bus.emit({
            type: AgentEventType.MCP_SERVER_CONNECTED,
            timestamp: Date.now(),
            payload: {
              serverName: serverConfig.name,
              capabilities: client.serverCapabilities,
              toolCount: mcpTools.length,
              promptCount: mcpPrompts.length,
              resourceCount: mcpResources.length,
            },
          });

          logger.info("MCP server registered", {
            server: serverConfig.name,
            tools: mcpTools.length,
            prompts: mcpPrompts.length,
            resources: mcpResources.length,
          });
        } catch (err) {
          logger.error("Failed to connect to MCP server", {
            server: serverConfig.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Add management slash commands
      commands.push(createStatusCommand(clients));
      commands.push(createToolsCommand(clients));
      commands.push(createPromptsCommand(clients));
      commands.push(createResourcesCommand(clients));
      commands.push(createLogLevelCommand(clientTransports));

      return {
        tools,
        commands,
        async dispose() {
          for (const client of clients) {
            try {
              await client.close();
              ctx.bus.emit({
                type: AgentEventType.MCP_SERVER_DISCONNECTED,
                timestamp: Date.now(),
                payload: { serverName: client.name, reason: "Plugin disposed" },
              });
            } catch (err) {
              logger.error("Error closing MCP client", {
                server: client.name,
                error: String(err),
              });
            }
          }
        },
      };
    },
  };
}

export { McpClientImpl } from "./client.js";
export { StdioTransport } from "./transport/stdio.js";
export { StreamableHttpTransport } from "./transport/http.js";
export { jsonSchemaToZod } from "./schema.js";
export type { McpTransport } from "./transport/types.js";
