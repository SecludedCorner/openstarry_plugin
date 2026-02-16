/**
 * JSON-RPC method router for MCP server.
 * Maps MCP protocol methods to handlers.
 */

import type { IPluginContext, ITool, IGuide, SlashCommand } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import { PROTOCOL_VERSION } from "@openstarry-plugin/mcp-common";
import type { JsonRpcRequest, JsonRpcResponse } from "./transport/types.js";
import { toolToMcpDefinition, executeToolForMcp } from "./adapters/tool-adapter.js";
import { guideToMcpDefinition, getPromptForMcp } from "./adapters/prompt-adapter.js";
import { commandToMcpResource, executeCommandAsResource, parseResourceUri } from "./adapters/resource-adapter.js";
import type { McpServerConfig } from "./index.js";

export function createMcpJsonRpcHandler(
  serverConfig: McpServerConfig,
  ctx: IPluginContext,
  commandRegistry?: Map<string, SlashCommand>,
): (req: JsonRpcRequest) => Promise<JsonRpcResponse> {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    try {
      switch (req.method) {
        case "initialize":
          return handleInitialize(req, serverConfig);

        case "notifications/initialized":
          ctx.bus.emit({
            type: AgentEventType.MCP_CLIENT_CONNECTED,
            timestamp: Date.now(),
            payload: {
              serverName: serverConfig.name,
              transport: serverConfig.transport,
              clientInfo: req.params?.clientInfo,
            },
          });
          return { jsonrpc: "2.0", id: req.id, result: {} };

        case "tools/list":
          return handleToolsList(req, serverConfig, ctx);

        case "tools/call":
          return await handleToolsCall(req, serverConfig, ctx);

        case "prompts/list":
          return handlePromptsList(req, serverConfig, ctx);

        case "prompts/get":
          return await handlePromptsGet(req, serverConfig, ctx);

        case "resources/list":
          return handleResourcesList(req, serverConfig, ctx, commandRegistry);

        case "resources/read":
          return await handleResourcesRead(req, serverConfig, ctx, commandRegistry);

        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32603,
          message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  };
}

function handleInitialize(
  req: JsonRpcRequest,
  config: McpServerConfig,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
      },
      serverInfo: {
        name: config.name,
        version: config.version,
      },
    },
  };
}

function handleToolsList(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
): JsonRpcResponse {
  if (!ctx.tools) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32600,
        message: "Tools not supported by this agent core version",
      },
    };
  }

  const allTools = ctx.tools.list();
  const exposedTools = filterExposed(allTools, config.exposedTools);
  const mcpTools = exposedTools.map((tool) => toolToMcpDefinition(tool));

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { tools: mcpTools },
  };
}

async function handleToolsCall(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
): Promise<JsonRpcResponse> {
  if (!ctx.tools) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Tools not supported" },
    };
  }

  const toolName = req.params?.name as string;
  const toolArgs = (req.params?.arguments as Record<string, unknown>) ?? {};

  const tool = ctx.tools.get(toolName);
  if (!tool) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Tool not found: ${toolName}` },
    };
  }

  // Check if tool is exposed
  const allTools = ctx.tools.list();
  const exposedTools = filterExposed(allTools, config.exposedTools);
  if (!exposedTools.some((t) => t.id === toolName)) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Tool not exposed: ${toolName}` },
    };
  }

  const result = await executeToolForMcp(tool, toolArgs, ctx);
  return { jsonrpc: "2.0", id: req.id, result };
}

function handlePromptsList(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
): JsonRpcResponse {
  if (!ctx.guides) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Prompts not supported" },
    };
  }

  const allGuides = ctx.guides.list();
  const exposedGuides = filterExposed(allGuides, config.exposedGuides);
  const mcpPrompts = exposedGuides.map((guide) => guideToMcpDefinition(guide));

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { prompts: mcpPrompts },
  };
}

async function handlePromptsGet(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
): Promise<JsonRpcResponse> {
  if (!ctx.guides) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Prompts not supported" },
    };
  }

  const promptName = req.params?.name as string;
  const allGuides = ctx.guides.list();
  const guide = allGuides.find((g) => g.id === promptName);

  if (!guide) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Prompt not found: ${promptName}` },
    };
  }

  // Check if guide is exposed
  const exposedGuides = filterExposed(allGuides, config.exposedGuides);
  if (!exposedGuides.some((g) => g.id === promptName)) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Prompt not exposed: ${promptName}` },
    };
  }

  const result = await getPromptForMcp(guide);
  return { jsonrpc: "2.0", id: req.id, result };
}

function handleResourcesList(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
  commandRegistry?: Map<string, SlashCommand>,
): JsonRpcResponse {
  if (!commandRegistry) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Resources not supported" },
    };
  }

  const allCommands = Array.from(commandRegistry.values());
  const exposedCommands = filterExposed(allCommands, config.exposedResources);
  const mcpResources = exposedCommands.map((command) => commandToMcpResource(command));

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { resources: mcpResources },
  };
}

async function handleResourcesRead(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: IPluginContext,
  commandRegistry?: Map<string, SlashCommand>,
): Promise<JsonRpcResponse> {
  if (!commandRegistry) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Resources not supported" },
    };
  }

  const uri = req.params?.uri as string;
  if (!uri) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Missing uri parameter" },
    };
  }

  const commandName = parseResourceUri(uri);
  if (!commandName) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Invalid resource URI: ${uri}` },
    };
  }

  const command = commandRegistry.get(commandName);
  if (!command) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: `Resource not found: ${commandName}` },
    };
  }

  // Check if command is exposed
  const allCommands = Array.from(commandRegistry.values());
  const exposedCommands = filterExposed(allCommands, config.exposedResources);
  if (!exposedCommands.some((c) => c.name === commandName)) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: `Resource not exposed: ${commandName}` },
    };
  }

  const result = await executeCommandAsResource(command, ctx);
  return { jsonrpc: "2.0", id: req.id, result };
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
