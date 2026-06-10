/**
 * Resource Adapter — converts OpenStarry SlashCommands to MCP resource definitions.
 *
 * Five Aggregates Mapping: SlashCommands (行蘊) → MCP Resources
 * Synthetic URI format: openstarry://command/{commandName}
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { McpResourceInfo, McpResourceResult, McpContent } from "@openstarry-plugin/mcp-common";

/**
 * Convert a SlashCommand to an MCP resource definition.
 * @param command - OpenStarry SlashCommand
 * @returns MCP resource metadata with synthetic URI
 */
export function commandToMcpResource(command: SlashCommand): McpResourceInfo {
  return {
    name: command.name,
    uri: `openstarry://command/${command.name}`,
    description: command.description,
    mimeType: "text/plain",
  };
}

/**
 * Execute a SlashCommand and return as MCP resource content.
 * @param command - SlashCommand to execute
 * @param ctx - Plugin context
 * @returns MCP resource result with text content
 */
export async function executeCommandAsResource(
  command: SlashCommand,
  ctx: IPluginContext,
): Promise<McpResourceResult> {
  try {
    // Execute command with empty args (resources don't support args in URI)
    const result = await command.execute("", ctx);

    const content: McpContent = {
      type: "text",
      text: result ?? "",
    };

    return {
      contents: [content],
    };
  } catch (err) {
    // Return error as text content
    const errorContent: McpContent = {
      type: "text",
      text: `Error executing command: ${err instanceof Error ? err.message : String(err)}`,
    };

    return {
      contents: [errorContent],
    };
  }
}

/**
 * Parse an MCP resource URI to extract the command name.
 * Expected format: openstarry://command/{commandName}
 * @param uri - MCP resource URI
 * @returns Command name or null if invalid format
 */
export function parseResourceUri(uri: string): string | null {
  const prefix = "openstarry://command/";
  if (!uri.startsWith(prefix)) {
    return null;
  }
  const commandName = uri.slice(prefix.length);
  // Security: ensure no path traversal or special chars
  if (!commandName || commandName.includes("/") || commandName.includes("..")) {
    return null;
  }
  return commandName;
}
