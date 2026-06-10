import type { Message, ChatRequest, ToolJsonSchema } from "@openstarry/sdk";

/**
 * OpenAI message format
 */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * OpenAI tool format
 */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert OpenStarry messages to OpenAI format
 */
export function convertMessages(
  messages: Message[],
  systemPrompt?: string
): OpenAIMessage[] {
  const openAIMessages: OpenAIMessage[] = [];

  // Add system prompt first if provided
  if (systemPrompt) {
    openAIMessages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  for (const message of messages) {
    if (message.role === "system") {
      // System message
      const textContent = message.content
        .filter((seg) => seg.type === "text")
        .map((seg) => (seg as { type: "text"; text: string }).text)
        .join("\n");
      if (textContent) {
        openAIMessages.push({
          role: "system",
          content: textContent,
        });
      }
    } else if (message.role === "user") {
      // Check if this is a tool result
      const toolResults = message.content.filter(
        (seg) => seg.type === "tool_result"
      );
      if (toolResults.length > 0) {
        // Tool result messages
        for (const seg of toolResults) {
          const toolResult = seg as {
            type: "tool_result";
            toolResult: { toolCallId: string; name: string; result: string };
          };
          openAIMessages.push({
            role: "tool",
            tool_call_id: toolResult.toolResult.toolCallId,
            content: toolResult.toolResult.result,
          });
        }
      } else {
        // Regular user message
        const textContent = message.content
          .filter((seg) => seg.type === "text")
          .map((seg) => (seg as { type: "text"; text: string }).text)
          .join("\n");
        if (textContent) {
          openAIMessages.push({
            role: "user",
            content: textContent,
          });
        }
      }
    } else if (message.role === "assistant") {
      // Check for tool calls
      const toolCalls = message.content.filter((seg) => seg.type === "tool_call");
      const textSegments = message.content.filter((seg) => seg.type === "text");

      if (toolCalls.length > 0) {
        // Assistant message with tool calls
        const openAIToolCalls = toolCalls.map((seg) => {
          const toolCall = seg as {
            type: "tool_call";
            toolCall: { id: string; name: string; arguments: Record<string, unknown> };
          };
          return {
            id: toolCall.toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.toolCall.name,
              arguments: JSON.stringify(toolCall.toolCall.arguments),
            },
          };
        });

        // If there's text content, add it first
        if (textSegments.length > 0) {
          const textContent = textSegments
            .map((seg) => (seg as { type: "text"; text: string }).text)
            .join("\n");
          openAIMessages.push({
            role: "assistant",
            content: textContent,
          });
        }

        // Add tool calls
        openAIMessages.push({
          role: "assistant",
          content: null,
          tool_calls: openAIToolCalls,
        });
      } else {
        // Regular assistant message
        const textContent = textSegments
          .map((seg) => (seg as { type: "text"; text: string }).text)
          .join("\n");
        if (textContent) {
          openAIMessages.push({
            role: "assistant",
            content: textContent,
          });
        }
      }
    }
  }

  return openAIMessages;
}

/**
 * Convert OpenStarry tool schemas to OpenAI format
 */
export function convertTools(tools: ToolJsonSchema[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Build OpenAI request payload
 */
export function buildRequestPayload(
  request: ChatRequest,
  apiMessages: OpenAIMessage[],
  apiTools?: OpenAITool[]
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: apiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.maxTokens !== undefined) {
    payload.max_tokens = request.maxTokens;
  }

  if (request.temperature !== undefined) {
    payload.temperature = request.temperature;
  }

  if (apiTools && apiTools.length > 0) {
    payload.tools = apiTools;
  }

  return payload;
}
