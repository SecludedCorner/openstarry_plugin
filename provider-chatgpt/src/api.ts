import type { ProviderStreamEvent, TokenUsage } from "@openstarry/sdk";
import type { OpenAIMessage, OpenAITool } from "./message-converter.js";

/**
 * OpenAI streaming response chunk
 */
interface OpenAIStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Tool call state tracker
 */
interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Stream chat completions from OpenAI API
 */
export async function* streamChatCompletions(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: OpenAIMessage[],
  options?: {
    tools?: OpenAITool[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }
): AsyncIterable<ProviderStreamEvent> {
  const url = `${baseUrl}/chat/completions`;

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (options?.maxTokens !== undefined) {
    payload.max_tokens = options.maxTokens;
  }

  if (options?.temperature !== undefined) {
    payload.temperature = options.temperature;
  }

  if (options?.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: new Error("No response body") };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, ToolCallState>();
  let usage: TokenUsage | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Extract usage if present (may be in same chunk as finish_reason)
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        const delta = choice.delta;

        // Handle text content
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index;
            let state = toolCalls.get(index);

            if (toolCall.id && toolCall.function?.name) {
              // Tool call start
              state = {
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments || "",
              };
              toolCalls.set(index, state);
              yield {
                type: "tool_call_start",
                toolCallId: state.id,
                name: state.name,
              };
            } else if (state && toolCall.function?.arguments) {
              // Tool call delta
              state.arguments += toolCall.function.arguments;
              yield {
                type: "tool_call_delta",
                toolCallId: state.id,
                input: toolCall.function.arguments,
              };
            }
          }
        }

        // Handle finish reason
        if (choice.finish_reason) {
          // Emit tool_call_end for all pending tool calls
          for (const state of toolCalls.values()) {
            yield {
              type: "tool_call_end",
              toolCallId: state.id,
              name: state.name,
              input: state.arguments,
            };
          }

          let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
          if (choice.finish_reason === "stop") {
            stopReason = toolCalls.size > 0 ? "tool_use" : "end_turn";
          } else if (choice.finish_reason === "tool_calls") {
            stopReason = "tool_use";
          } else if (choice.finish_reason === "length") {
            stopReason = "max_tokens";
          } else {
            stopReason = "error";
          }

          yield { type: "finish", stopReason, usage };
          return;
        }
      }
    }
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    reader.releaseLock();
  }
}
