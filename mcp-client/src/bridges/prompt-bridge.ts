/**
 * Prompt Bridge — converts MCP prompts to OpenStarry SlashCommand instances.
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { McpClientImpl, McpContent } from "../client.js";

function extractText(content: McpContent): string {
  if (content.type === "text") return content.text;
  if (content.type === "resource") return content.text ?? `[resource: ${content.uri}]`;
  return `[${content.type}]`;
}

export function createMcpPromptBridge(
  serverName: string,
  promptName: string,
  description: string,
  client: McpClientImpl,
): SlashCommand {
  return {
    name: `mcp:${serverName}:${promptName}`,
    description,

    async execute(args: string, _ctx: IPluginContext): Promise<string> {
      // Parse key=value arguments
      const parsedArgs: Record<string, string> = {};
      if (args.trim()) {
        for (const pair of args.trim().split(/\s+/)) {
          const eqIndex = pair.indexOf("=");
          if (eqIndex > 0) {
            parsedArgs[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
          }
        }
      }

      const result = await client.getPrompt(promptName, parsedArgs);

      const lines: string[] = [`[Prompt: ${promptName}]`];
      if (result.description) {
        lines.push(`Description: ${result.description}`);
      }
      for (const msg of result.messages) {
        lines.push(`${msg.role}: ${extractText(msg.content)}`);
      }
      return lines.join("\n");
    },
  };
}
