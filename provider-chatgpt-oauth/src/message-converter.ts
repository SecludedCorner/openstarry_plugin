/**
 * Message converter for OpenAI Codex Responses API format.
 *
 * Converts OpenStarry Message[] → Codex input[] format.
 * Codex uses a different message format than Chat Completions:
 *   - User: { role: "user", content: [{ type: "input_text", text }] }
 *   - Assistant text: { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
 *   - Tool call: { type: "function_call", call_id, id, name, arguments }
 *   - Tool result: { type: "function_call_output", call_id, output }
 */
import type { Message, ToolJsonSchema } from "@openstarry/sdk";
import type { CodexToolDef } from "./api.js";

/**
 * Convert OpenStarry messages to Codex Responses API input format.
 */
export function convertMessages(messages: Message[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const toolResults = message.content.filter((seg) => seg.type === "tool_result");

      if (toolResults.length > 0) {
        for (const seg of toolResults) {
          const tr = seg as {
            type: "tool_result";
            toolResult: { toolCallId: string; name: string; result: string };
          };
          input.push({
            type: "function_call_output",
            call_id: tr.toolResult.toolCallId,
            output: tr.toolResult.result,
          });
        }
      } else {
        const textContent = message.content
          .filter((seg) => seg.type === "text")
          .map((seg) => (seg as { type: "text"; text: string }).text)
          .join("\n");
        if (textContent) {
          input.push({
            role: "user",
            content: [{ type: "input_text", text: textContent }],
          });
        }
      }
    } else if (message.role === "assistant") {
      const toolCalls = message.content.filter((seg) => seg.type === "tool_call");
      const textSegments = message.content.filter((seg) => seg.type === "text");

      if (textSegments.length > 0) {
        const textContent = textSegments
          .map((seg) => (seg as { type: "text"; text: string }).text)
          .join("\n");
        if (textContent) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: textContent, annotations: [] }],
            status: "completed",
          });
        }
      }

      for (const seg of toolCalls) {
        const tc = seg as {
          type: "tool_call";
          toolCall: { id: string; name: string; arguments: Record<string, unknown> };
        };
        input.push({
          type: "function_call",
          call_id: tc.toolCall.id,
          id: `fc_${tc.toolCall.id}`,
          name: sanitizeToolName(tc.toolCall.name),
          arguments: JSON.stringify(tc.toolCall.arguments),
        });
      }
    } else if (message.role === "tool") {
      // Tool result messages (same handling as user tool_result)
      for (const seg of message.content) {
        if (seg.type === "tool_result") {
          const tr = seg as {
            type: "tool_result";
            toolResult: { toolCallId: string; name: string; result: string };
          };
          input.push({
            type: "function_call_output",
            call_id: tr.toolResult.toolCallId,
            output: tr.toolResult.result,
          });
        }
      }
    }
    // System messages handled via `instructions` field
  }

  return input;
}

/**
 * Convert OpenStarry tool schemas to Codex tool format.
 */
/**
 * Sanitize tool name to match Codex pattern: ^[a-zA-Z0-9_-]+$
 * Replaces dots and other invalid chars with underscores.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function convertTools(tools: ToolJsonSchema[]): CodexToolDef[] {
  return tools.map((tool) => ({
    type: "function" as const,
    name: sanitizeToolName(tool.name),
    description: tool.description,
    parameters: tool.parameters,
    strict: null,
  }));
}
