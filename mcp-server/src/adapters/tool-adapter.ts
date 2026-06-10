/**
 * Tool adapter — converts ITool to MCP tool definition and executes tools for MCP clients.
 */

import type { ITool, ToolContext } from "@openstarry/sdk";
import type { IPluginContext } from "@openstarry/sdk";
import { zodToJsonSchema } from "@openstarry/shared";
import type { McpToolInfo, McpToolResult } from "@openstarry-plugin/mcp-common";

export type { McpToolInfo, McpToolResult, McpContent } from "@openstarry-plugin/mcp-common";

/** Convert an ITool to MCP tool definition. */
export function toolToMcpDefinition(tool: ITool): McpToolInfo {
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.parameters) as McpToolInfo["inputSchema"],
  };
}

/** Execute an ITool in response to MCP tools/call request. */
export async function executeToolForMcp(
  tool: ITool,
  args: Record<string, unknown>,
  ctx: IPluginContext,
): Promise<McpToolResult> {
  const validationResult = tool.parameters.safeParse(args);
  if (!validationResult.success) {
    return {
      content: [
        {
          type: "text",
          text: `Validation error: ${validationResult.error.message}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const toolCtx: ToolContext = {
      workingDirectory: ctx.workingDirectory,
      allowedPaths: [ctx.workingDirectory],
      bus: ctx.bus,
    };

    const result = await tool.execute(validationResult.data, toolCtx);

    return {
      content: [{ type: "text", text: result }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
