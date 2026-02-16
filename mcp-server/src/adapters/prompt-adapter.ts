/**
 * Prompt adapter — converts IGuide to MCP prompt definition and retrieves prompts for MCP clients.
 */

import type { IGuide } from "@openstarry/sdk";
import type { McpPromptInfo, McpPromptResult } from "@openstarry-plugin/mcp-common";

export type { McpPromptInfo, McpPromptResult } from "@openstarry-plugin/mcp-common";

/** Convert an IGuide to MCP prompt definition. */
export function guideToMcpDefinition(guide: IGuide): McpPromptInfo {
  return {
    name: guide.id,
    description: guide.name,
    arguments: [],
  };
}

/** Retrieve IGuide system prompt as MCP prompt result. */
export async function getPromptForMcp(guide: IGuide): Promise<McpPromptResult> {
  const systemPrompt = await guide.getSystemPrompt();

  return {
    description: guide.name,
    messages: [
      {
        role: "user",
        content: { type: "text", text: systemPrompt },
      },
    ],
  };
}
