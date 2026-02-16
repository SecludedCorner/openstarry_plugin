/**
 * Tool Bridge — converts MCP tools to OpenStarry ITool instances.
 */
import type { ITool, ToolContext } from "@openstarry/sdk";
import { ToolExecutionError } from "@openstarry/sdk";
import type { ZodType } from "zod";
import type { McpClientImpl, McpContent } from "../client.js";

function extractContent(content: McpContent[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text") {
      parts.push(c.text);
    } else if (c.type === "image") {
      parts.push(`[image: ${c.mimeType}]`);
    } else if (c.type === "resource") {
      parts.push(c.text ?? `[resource: ${c.uri}]`);
    }
  }
  return parts.join("\n");
}

export function createMcpToolBridge(
  serverName: string,
  toolName: string,
  description: string,
  schema: ZodType,
  client: McpClientImpl,
): ITool {
  const id = `${serverName}/${toolName}`;

  return {
    id,
    description,
    parameters: schema,

    async execute(input: unknown, _ctx: ToolContext): Promise<string> {
      try {
        const result = await client.callTool(toolName, (input ?? {}) as Record<string, unknown>);

        if (result.isError) {
          const errorText = extractContent(result.content);
          throw new Error(errorText || "MCP tool returned an error");
        }

        return extractContent(result.content);
      } catch (err) {
        if (err instanceof ToolExecutionError) throw err;
        throw new ToolExecutionError(
          id,
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err : undefined,
        );
      }
    },
  };
}
