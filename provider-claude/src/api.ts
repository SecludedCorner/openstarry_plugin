/**
 * api.ts — Anthropic Messages API streaming client.
 */

import type { ProviderStreamEvent, TokenUsage } from "@openstarry/sdk";
import type { AnthropicMessage, AnthropicTool } from "./message-converter.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeStreamRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  temperature?: number;
  stream: true;
}

interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    model: string;
    usage: { input_tokens: number };
  };
}

interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: string }
    | { type: "thinking"; thinking: string };
}

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

interface MessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: string };
  usage: { output_tokens: number };
}

interface MessageStopEvent {
  type: "message_stop";
}

type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

interface CurrentBlock {
  type: "text" | "tool_use" | "thinking";
  toolCallId?: string;
  name?: string;
  accumulatedInput?: string;
}

/**
 * Stream Claude Messages API responses and convert to ProviderStreamEvent.
 */
export async function* streamClaudeMessages(
  apiKey: string,
  request: ClaudeStreamRequest,
  signal?: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  let response: Response;

  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    yield {
      type: "error",
      error: new Error(`Anthropic API error: ${response.status} ${text}`),
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
  let currentBlock: CurrentBlock | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(jsonStr) as AnthropicStreamEvent;
        } catch {
          continue; // Ignore parse errors
        }

        // Handle events
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === "content_block_start") {
          const block = event.content_block;

          if (block.type === "text") {
            currentBlock = { type: "text" };
          } else if (block.type === "tool_use") {
            currentBlock = {
              type: "tool_use",
              toolCallId: block.id,
              name: block.name,
              accumulatedInput: "",
            };
            yield {
              type: "tool_call_start",
              toolCallId: block.id,
              name: block.name,
            };
          } else if (block.type === "thinking") {
            currentBlock = { type: "thinking" };
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;

          if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            if (currentBlock?.type === "tool_use" && currentBlock.toolCallId) {
              currentBlock.accumulatedInput =
                (currentBlock.accumulatedInput ?? "") + delta.partial_json;
              yield {
                type: "tool_call_delta",
                toolCallId: currentBlock.toolCallId,
                input: delta.partial_json,
              };
            }
          } else if (delta.type === "thinking_delta") {
            yield { type: "reasoning_delta", text: delta.thinking };
          }
        } else if (event.type === "content_block_stop") {
          if (currentBlock?.type === "tool_use" && currentBlock.toolCallId && currentBlock.name) {
            yield {
              type: "tool_call_end",
              toolCallId: currentBlock.toolCallId,
              name: currentBlock.name,
              input: currentBlock.accumulatedInput ?? "",
            };
          }
          currentBlock = null;
        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
          const stopReason = mapStopReason(event.delta.stop_reason);
          const usage: TokenUsage = {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          yield { type: "finish", stopReason, usage };
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr) {
        try {
          const event = JSON.parse(jsonStr) as AnthropicStreamEvent;
          if (event.type === "message_delta") {
            outputTokens = event.usage.output_tokens;
            const stopReason = mapStopReason(event.delta.stop_reason);
            const usage: TokenUsage = {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
            };
            yield { type: "finish", stopReason, usage };
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function mapStopReason(
  reason: string,
): "end_turn" | "tool_use" | "max_tokens" | "error" {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "error";
  }
}
