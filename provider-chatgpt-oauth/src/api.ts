/**
 * ChatGPT Codex Responses API — streaming client.
 *
 * Uses the Codex backend endpoint (chatgpt.com/backend-api/codex/responses)
 * with the OpenAI Responses API format (not Chat Completions).
 */
import type { ProviderStreamEvent, TokenUsage } from "@openstarry/sdk";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

export interface CodexMessage {
  role: "user" | "assistant" | "system";
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface CodexToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: null;
}

export interface CodexRequest {
  model: string;
  store: boolean;
  stream: boolean;
  instructions: string;
  input: unknown[];
  tools?: CodexToolDef[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  include?: string[];
}

interface ToolCallState {
  callId: string;
  itemId: string;
  name: string;
  partialJson: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stream responses from the Codex Responses API.
 */
export async function* streamCodexResponses(
  accessToken: string,
  accountId: string,
  request: CodexRequest,
  options?: {
    signal?: AbortSignal;
  },
): AsyncGenerator<ProviderStreamEvent> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    originator: "openstarry",
  };

  const bodyJson = JSON.stringify(request);

  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (options?.signal?.aborted) {
      yield { type: "error", error: new Error("Request was aborted") };
      return;
    }
    try {
      response = await fetch(DEFAULT_CODEX_BASE_URL, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: options?.signal,
      });
      if (response.ok) break;

      const errorText = await response.text();
      if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      // Parse friendly error
      try {
        const parsed = JSON.parse(errorText);
        const detail = parsed?.detail || parsed?.error?.message;
        if (detail) {
          yield { type: "error", error: new Error(`Codex API error: ${response.status} ${detail}`) };
          return;
        }
      } catch { /* not JSON */ }
      yield { type: "error", error: new Error(`Codex API error: ${response.status} ${errorText}`) };
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
    }
  }

  if (!response?.ok) {
    yield { type: "error", error: lastError ?? new Error("Failed after retries") };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: new Error("No response body") };
    return;
  }

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<string, ToolCallState>();
  let usage: TokenUsage | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");

      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        for (const data of dataLines) {
          if (!data || data === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const type = event.type as string;

          switch (type) {
            // ─── Text output ───
            case "response.output_text.delta": {
              const delta = (event.delta as string) || "";
              if (delta) yield { type: "text_delta", text: delta };
              break;
            }

            // ─── Tool call start ───
            case "response.output_item.added": {
              const item = event.item as Record<string, unknown>;
              if (item?.type === "function_call") {
                const callId = (item.call_id as string) || "";
                const itemId = (item.id as string) || "";
                const name = (item.name as string) || "";
                const state: ToolCallState = { callId, itemId, name, partialJson: "" };
                toolCalls.set(itemId, state);
                yield { type: "tool_call_start", toolCallId: callId, name };
              }
              break;
            }

            // ─── Tool call argument delta ───
            case "response.function_call_arguments.delta": {
              const delta = (event.delta as string) || "";
              const itemId = (event.item_id as string) || "";
              const state = toolCalls.get(itemId);
              if (state && delta) {
                state.partialJson += delta;
                yield { type: "tool_call_delta", toolCallId: state.callId, input: delta };
              }
              break;
            }

            // ─── Tool call / item done ───
            case "response.output_item.done": {
              const item = event.item as Record<string, unknown>;
              if (item?.type === "function_call") {
                const callId = (item.call_id as string) || "";
                const name = (item.name as string) || "";
                const args = (item.arguments as string) || "{}";
                yield { type: "tool_call_end", toolCallId: callId, name, input: args };
              }
              break;
            }

            // ─── Response complete ───
            case "response.completed":
            case "response.done": {
              const resp = event.response as Record<string, unknown> | undefined;
              const respUsage = resp?.usage as Record<string, unknown> | undefined;
              if (respUsage) {
                const cachedTokens = (
                  respUsage.input_tokens_details as Record<string, unknown> | undefined
                )?.cached_tokens as number || 0;
                const inputTokens = (respUsage.input_tokens as number) || 0;
                const outputTokens = (respUsage.output_tokens as number) || 0;
                usage = {
                  promptTokens: inputTokens - cachedTokens,
                  completionTokens: outputTokens,
                  totalTokens: (respUsage.total_tokens as number) || 0,
                };
              }

              const status = resp?.status as string | undefined;
              const hasToolCalls = toolCalls.size > 0;
              let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";

              if (hasToolCalls) {
                stopReason = "tool_use";
              } else if (status === "incomplete") {
                stopReason = "max_tokens";
              } else if (status === "failed" || status === "cancelled") {
                stopReason = "error";
              } else {
                stopReason = "end_turn";
              }

              yield { type: "finish", stopReason, usage };
              return;
            }

            // ─── Errors ───
            case "error": {
              const msg = (event.message as string) || JSON.stringify(event);
              yield { type: "error", error: new Error(`Codex error: ${msg}`) };
              return;
            }
            case "response.failed": {
              const resp = event.response as Record<string, unknown> | undefined;
              const err = resp?.error as Record<string, unknown> | undefined;
              const msg = (err?.message as string) || "Response failed";
              yield { type: "error", error: new Error(msg) };
              return;
            }
          }
        }

        idx = buffer.indexOf("\n\n");
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
