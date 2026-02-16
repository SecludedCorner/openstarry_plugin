/**
 * Resource Bridge — converts MCP resources to OpenStarry SlashCommand instances.
 *
 * Five Aggregates Mapping: Resources → 行蘊 (Samskara - Action/Volition)
 * Rationale: Reading a resource is a data-fetching action (read-only command).
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { McpClientImpl, McpContent, McpResourceInfo } from "../client.js";

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

/**
 * Create a SlashCommand that bridges an MCP resource.
 * Command name format: `mcp-resource:{serverName}:{resourceName}`
 *
 * @param serverName - MCP server name (for namespacing)
 * @param resourceInfo - MCP resource metadata
 * @param client - MCP client instance to read resource
 * @returns SlashCommand that reads and returns the resource content
 */
export function createMcpResourceBridge(
  serverName: string,
  resourceInfo: McpResourceInfo,
  client: McpClientImpl,
): SlashCommand {
  return {
    name: `mcp-resource:${serverName}:${resourceInfo.name}`,
    description: resourceInfo.description ?? `MCP resource from ${serverName}`,

    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      try {
        const result = await client.readResource(resourceInfo.uri);
        return extractContent(result.contents);
      } catch (err) {
        return `Error reading resource: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
