/**
 * message-converter.ts — Convert OpenStarry Message[] to Anthropic Messages API format.
 */

import type { Message, ContentSegment } from "@openstarry/sdk";
import type { ToolJsonSchema } from "@openstarry/sdk";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string }
    | { type: "thinking"; thinking: string }
  >;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ConvertedMessages {
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

/**
 * Convert OpenStarry messages to Anthropic format.
 * - Extract system messages → top-level `system` string
 * - User messages with text → { role: "user", content: [{ type: "text", text: "..." }] }
 * - User messages with tool_result → { role: "user", content: [{ type: "tool_result", tool_use_id, content }] }
 * - Assistant messages with text → { type: "text", text: "..." }
 * - Assistant messages with tool_call → { type: "tool_use", id, name, input }
 * - Assistant messages with reasoning → { type: "thinking", thinking: "..." }
 */
export function convertMessages(
  messages: Message[],
  systemPrompt?: string,
  tools?: ToolJsonSchema[],
): ConvertedMessages {
  const anthropicMessages: AnthropicMessage[] = [];
  let collectedSystemPrompt = systemPrompt;

  // Extract system messages
  for (const msg of messages) {
    if (msg.role === "system") {
      const texts = msg.content
        .filter((c): c is ContentSegment & { type: "text" } => c.type === "text")
        .map((c) => c.text);
      if (texts.length > 0) {
        collectedSystemPrompt = texts.join("\n");
      }
      continue;
    }

    if (msg.role === "user") {
      const content: AnthropicMessage["content"] = [];

      for (const seg of msg.content) {
        if (seg.type === "text") {
          content.push({ type: "text", text: seg.text });
        } else if (seg.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: seg.toolResult.toolCallId,
            content: seg.toolResult.result,
          });
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      const content: AnthropicMessage["content"] = [];

      for (const seg of msg.content) {
        if (seg.type === "text") {
          content.push({ type: "text", text: seg.text });
        } else if (seg.type === "tool_call") {
          content.push({
            type: "tool_use",
            id: seg.toolCall.id,
            name: seg.toolCall.name,
            input: seg.toolCall.arguments,
          });
        } else if (seg.type === "reasoning") {
          content.push({ type: "thinking", thinking: seg.text });
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      // Tool messages are converted to user messages with tool_result
      const content: AnthropicMessage["content"] = [];

      for (const seg of msg.content) {
        if (seg.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: seg.toolResult.toolCallId,
            content: seg.toolResult.result,
          });
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: "user", content });
      }
    }
  }

  // Convert tools
  const anthropicTools = tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));

  return {
    system: collectedSystemPrompt,
    messages: anthropicMessages,
    tools: anthropicTools && anthropicTools.length > 0 ? anthropicTools : undefined,
  };
}
