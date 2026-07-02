import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IProvider,
  ChatRequest,
  ProviderStreamEvent,
  ModelInfo,
  SlashCommand,
} from "@openstarry/sdk";
import { createLogger, SecureStore } from "@openstarry/shared";

const logger = createLogger("lmstudio");

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

interface StoredConfig {
  baseUrl: string;
}

/**
 * Fetch model list from LM Studio /v1/models endpoint.
 */
async function fetchModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const resp = await fetch(`${baseUrl}/models`);
    if (!resp.ok) return [];

    const body = (await resp.json()) as {
      data?: { id: string; owned_by?: string }[];
    };
    if (!body.data || !Array.isArray(body.data)) return [];

    return body.data
      .filter((m) => !m.id.includes("embedding"))
      .map((m) => ({ id: m.id, name: m.id, contextWindow: 4096 }));
  } catch {
    return [];
  }
}

// ─── Pure helpers (extracted for unit testing; wire behavior identical) ───

/**
 * One fragment of a streamed tool call (OpenAI `delta.tool_calls[]` entry).
 * Wire-verified against LM Studio (2026-07-02, qwen3.5-9b): the FIRST fragment
 * carries `index`, `id`, `type`, `function.name` (+ empty `arguments`);
 * follow-up fragments carry only `index` + `function.arguments` pieces —
 * assembly is keyed by `index`.
 */
export interface OpenAiToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Shape of a single OpenAI-compatible streaming chunk (`chat.completion.chunk`)
 * as emitted by LM Studio over SSE. Only the fields this provider reads.
 * `reasoning_content` is LM Studio's delta field for reasoning models
 * (qwen3.5 etc.) — mapped to the SDK's `reasoning_delta`.
 */
export interface OpenAiStreamChunk {
  choices?: {
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCallFragment[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

/** Result of classifying one SSE line. */
export type SseLineResult =
  | { kind: "chunk"; chunk: OpenAiStreamChunk }
  | { kind: "done" }
  | { kind: "skip" };

/**
 * Classify a single SSE line (pure function — extracted for unit testing).
 *
 * Wire-identical to the previous inline logic:
 *   - blank lines, non-`data: ` lines, and malformed JSON → `skip` (silent)
 *   - `data: [DONE]` sentinel → `done` (informational; the finish event
 *     derives from `finish_reason`, never from `[DONE]`)
 *   - `data: {json}` → `chunk` with the parsed payload
 *
 * Note the prefix check requires `"data: "` WITH the trailing space, matching
 * the original code; `data:{...}` (no space) is skipped.
 */
export function parseSseLine(line: string): SseLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "skip" };
  if (trimmed === "data: [DONE]") return { kind: "done" };
  if (!trimmed.startsWith("data: ")) return { kind: "skip" };

  try {
    return { kind: "chunk", chunk: JSON.parse(trimmed.slice(6)) as OpenAiStreamChunk };
  } catch {
    return { kind: "skip" };
  }
}

/**
 * Stateful per-request stream mapper (L block — native tool calling).
 *
 * OpenAI streams a tool call as FRAGMENTS across chunks (first fragment:
 * index/id/name; later fragments: index + argument pieces), so assembly needs
 * per-stream state — one mapper instance per chat() request.
 *
 * Event mapping:
 *   - `delta.reasoning_content` → `reasoning_delta` (LM Studio reasoning models)
 *   - `delta.content` → `text_delta` (empty string skipped, as before)
 *   - `delta.tool_calls` fragments → `tool_call_start` once id+name are known,
 *     then `tool_call_delta` PER argument fragment (load-bearing: the agent
 *     loop fills its input buffer from deltas, NOT from end.input — the
 *     provider-claude-cli lesson), argument pieces that arrive before the
 *     name are buffered and flushed right after start.
 *   - `finish_reason "tool_calls"` → `tool_call_end` per assembled call, then
 *     `finish {stopReason: "tool_use"}` (previously mis-mapped to end_turn).
 *   - `finish_reason "length"` → max_tokens; other truthy values → end_turn.
 *   - `chunk.usage` on the finish chunk → TokenUsage.
 *
 * Faithful-extraction note preserved: `choices[0].delta` is accessed without
 * guarding `delta` itself — a chunk whose first choice lacks `delta` throws
 * TypeError, which chat()'s try/catch converts into an `error` event.
 */
export function createOpenAiStreamMapper(genId: () => string = () => randomUUID()): {
  mapChunk(chunk: OpenAiStreamChunk): ProviderStreamEvent[];
} {
  interface CallAccumulator {
    id: string | null;
    name: string;
    args: string;
    started: boolean;
    pendingArgs: string[];
  }
  const calls = new Map<number, CallAccumulator>();

  return {
    mapChunk(chunk: OpenAiStreamChunk): ProviderStreamEvent[] {
      const events: ProviderStreamEvent[] = [];

      const choices = chunk.choices;
      if (!choices || choices.length === 0) return events;

      const delta = choices[0].delta;
      if (delta.reasoning_content) {
        events.push({ type: "reasoning_delta", text: delta.reasoning_content });
      }
      if (delta.content) {
        events.push({ type: "text_delta", text: delta.content });
      }

      for (const frag of delta.tool_calls ?? []) {
        const index = frag.index ?? 0;
        let acc = calls.get(index);
        if (!acc) {
          acc = { id: null, name: "", args: "", started: false, pendingArgs: [] };
          calls.set(index, acc);
        }
        if (frag.id) acc.id = frag.id;
        if (frag.function?.name) acc.name += frag.function.name;

        if (!acc.started && acc.name) {
          acc.id = acc.id ?? genId();
          acc.started = true;
          events.push({ type: "tool_call_start", toolCallId: acc.id, name: acc.name });
          for (const piece of acc.pendingArgs) {
            acc.args += piece;
            events.push({ type: "tool_call_delta", toolCallId: acc.id, input: piece });
          }
          acc.pendingArgs = [];
        }

        if (frag.function?.arguments) {
          if (acc.started && acc.id) {
            acc.args += frag.function.arguments;
            events.push({ type: "tool_call_delta", toolCallId: acc.id, input: frag.function.arguments });
          } else {
            acc.pendingArgs.push(frag.function.arguments);
          }
        }
      }

      const finishReason = choices[0].finish_reason;
      if (finishReason) {
        if (finishReason === "tool_calls") {
          for (const [, acc] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
            // a call that never received a name cannot be executed — skip honestly
            if (!acc.started || !acc.id) continue;
            events.push({ type: "tool_call_end", toolCallId: acc.id, name: acc.name, input: acc.args });
          }
        }
        const usage = chunk.usage;
        events.push({
          type: "finish",
          stopReason:
            finishReason === "length" ? "max_tokens" : finishReason === "tool_calls" ? "tool_use" : "end_turn",
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
        });
      }

      return events;
    },
  };
}

/**
 * Back-compat single-chunk mapper (a fresh assembler per call — identical to
 * the old pure function for text/finish/usage chunks; kept for existing tests
 * and external callers). chat() uses a per-request createOpenAiStreamMapper.
 */
export function mapOpenAiChunk(chunk: OpenAiStreamChunk): ProviderStreamEvent[] {
  return createOpenAiStreamMapper().mapChunk(chunk);
}

/**
 * Build the OpenAI-compatible request payload for `POST /chat/completions`
 * (pure function — extracted for unit testing).
 *
 * Key order (model, messages, stream, max_tokens?, temperature?) matches the
 * previous inline construction so `JSON.stringify` emits identical bytes for
 * tool-less requests. `maxTokens`/`temperature` use `!== undefined` checks
 * (0 is forwarded). When the agent supplies tools (L block), they are appended
 * as native OpenAI function declarations with `tool_choice: "auto"` — LM
 * Studio supports OpenAI function-calling for tool-capable models.
 */
export function buildPayload(request: ChatRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: convertMessages(request.messages, request.systemPrompt),
    stream: true,
  };

  if (request.maxTokens !== undefined) {
    payload.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    payload.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    payload.tool_choice = "auto";
  }

  return payload;
}

/**
 * LM Studio Provider — OpenAI-compatible local inference server.
 *
 * Exported for unit/integration testing (stubbed global fetch); production
 * consumers go through `createLmStudioPlugin()` as before.
 */
export class LmStudioProvider implements IProvider {
  public readonly skandha = 'samjna' as const;
  public readonly id = "lmstudio";
  public readonly name = "LM Studio (Local)";
  public readonly loginHint = { usage: "[URL]", description: "LM Studio" };
  public models: ModelInfo[] = [];

  public baseUrl: string = DEFAULT_BASE_URL;
  public configured = false;

  isConfigured(): boolean {
    return this.configured;
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.configured) {
      yield {
        type: "error",
        error: new Error(
          "LM Studio not configured. Use /provider login lmstudio [BASE_URL] to connect."
        ),
      };
      return;
    }

    const payload = buildPayload(request);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`
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
    // Per-request mapper: tool-call fragments assemble across chunks (L block).
    const mapper = createOpenAiStreamMapper();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const parsed = parseSseLine(line);
          // "done" ([DONE] sentinel) and "skip" are both wire-level no-ops,
          // exactly as before extraction: the finish event derives from
          // finish_reason, never from [DONE].
          if (parsed.kind !== "chunk") continue;

          for (const event of mapper.mapChunk(parsed.chunk)) {
            yield event;
            if (event.type === "finish") return;
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
}

/** OpenAI-compatible chat message (widened for tool traffic, L block). */
export interface OpenAiChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Message converter (OpenAI-compatible format).
 *
 * Pure function — exported for unit testing. Text handling unchanged:
 * optional systemPrompt becomes a leading `system` message; text segments are
 * joined with `\n`; a message with neither text nor tool segments is dropped.
 *
 * L block: tool segments are no longer discarded (they were — which broke the
 * multi-turn tool loop, findings.md 2026-07-01):
 *   - `tool_call` segments → an assistant message carrying OpenAI
 *     `tool_calls` (arguments JSON-stringified), with any same-message text as
 *     `content` (null when absent, per the OpenAI schema).
 *   - `tool_result` segments → one `role:"tool"` message each, carrying
 *     `tool_call_id` — the result feedback the model reads on the next round.
 */
export function convertMessages(
  messages: ChatRequest["messages"],
  systemPrompt?: string
): OpenAiChatMessage[] {
  const result: OpenAiChatMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const text = msg.content
      .filter((seg) => seg.type === "text")
      .map((seg) => (seg as { type: "text"; text: string }).text)
      .join("\n");
    const toolCalls = msg.content.filter((seg) => seg.type === "tool_call");
    const toolResults = msg.content.filter((seg) => seg.type === "tool_result");

    if (toolCalls.length > 0) {
      result.push({
        role: msg.role,
        content: text || null,
        tool_calls: toolCalls.map((seg) => {
          const tc = (seg as { type: "tool_call"; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall;
          return {
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          };
        }),
      });
    } else if (text) {
      result.push({ role: msg.role, content: text });
    }

    for (const seg of toolResults) {
      const tr = (seg as { type: "tool_result"; toolResult: { toolCallId: string; result: string } }).toolResult;
      result.push({ role: "tool", content: tr.result, tool_call_id: tr.toolCallId });
    }
  }

  return result;
}

export function createLmStudioPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-lmstudio",
      version: "0.1.0-alpha",
      description: "LM Studio provider — connect to local LM Studio server (OpenAI-compatible API)",
      skandha: 'samjna' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = join(homedir(), ".openstarry", "plugins", "lmstudio");
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-provider-lmstudio",
      });
      await storage.ensureDir();

      const provider = new LmStudioProvider();

      // Determine baseUrl: plugin config > stored config > default
      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configBaseUrl = pluginConfig?.baseUrl as string | undefined;

      // Try to restore previous config or use plugin config
      try {
        const stored = await storage.readSecure<StoredConfig>("config.enc.json");
        const baseUrl = configBaseUrl ?? stored?.baseUrl;
        if (baseUrl) {
          provider.baseUrl = baseUrl;
          const models = await fetchModels(provider.baseUrl);
          if (models.length > 0) {
            provider.models = models;
            provider.configured = true;
            logger.info(
              `Connected to LM Studio at ${provider.baseUrl} (${models.length} models)`
            );
          } else {
            logger.info(
              `LM Studio not reachable at ${provider.baseUrl}. Use /provider login lmstudio [BASE_URL]`
            );
          }
        } else {
          logger.info(
            "Not configured. Use /provider login lmstudio [BASE_URL]"
          );
        }
      } catch {
        logger.info(
          "Not configured. Use /provider login lmstudio [BASE_URL]"
        );
      }

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage LM Studio provider (login/logout/status/remove)",
          async execute(args: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // /provider login lmstudio [BASE_URL]
            if (subCmd === "login" && providerName === "lmstudio") {
              const baseUrl = parts[2] || DEFAULT_BASE_URL;

              const models = await fetchModels(baseUrl);
              if (models.length === 0) {
                return `Cannot connect to LM Studio at ${baseUrl}. Make sure LM Studio is running.`;
              }

              try {
                await storage.writeSecure("config.enc.json", { baseUrl });
              } catch {
                // Non-critical
              }

              provider.baseUrl = baseUrl;
              provider.models = models;
              provider.configured = true;

              const modelList = models.map((m) => `  - ${m.id}`).join("\n");
              return `LM Studio connected at ${baseUrl}\n\nAvailable models (${models.length}):\n${modelList}\n\nUse /provider model <id> to select a model.`;
            }

            // /provider logout lmstudio
            if (subCmd === "logout" && providerName === "lmstudio") {
              provider.configured = false;
              provider.models = [];
              try {
                await storage.delete("config.enc.json");
              } catch {
                // ignore
              }
              return "LM Studio provider disconnected.";
            }

            // /provider remove lmstudio
            if (subCmd === "remove" && providerName === "lmstudio") {
              provider.configured = false;
              provider.models = [];
              try {
                await storage.delete("config.enc.json");
              } catch {
                // ignore
              }
              return "LM Studio provider removed.";
            }

            // /provider status (handled by all providers — return if ours)
            if (subCmd === "status" && !providerName) {
              return undefined; // Let handler chain continue
            }

            return undefined;
          },
        },
      ];

      return {
        providers: [provider],
        commands,
        dispose: async () => {
          // No cleanup needed
        },
      };
    },
  };
}

export default createLmStudioPlugin;
