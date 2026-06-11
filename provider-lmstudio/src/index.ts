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
 * Shape of a single OpenAI-compatible streaming chunk (`chat.completion.chunk`)
 * as emitted by LM Studio over SSE. Only the fields this provider reads.
 */
export interface OpenAiStreamChunk {
  choices?: { delta: { content?: string }; finish_reason?: string | null }[];
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
 * Map one parsed OpenAI-compatible chunk to OpenStarry ProviderStreamEvents
 * (pure function — extracted for unit testing).
 *
 * Mapping preserved exactly from the previous inline logic:
 *   - missing/empty `choices` → no events
 *   - truthy `choices[0].delta.content` → `text_delta` (empty string skipped)
 *   - truthy `choices[0].finish_reason` → `finish`; stopReason is
 *     `"max_tokens"` for `finish_reason === "length"`, `"end_turn"` for every
 *     other truthy value (`"stop"`, `"tool_calls"`, ...); `null` → no finish
 *   - `chunk.usage` (when present on the finish chunk) → TokenUsage
 *
 * Faithful-extraction note: like the original inline code, this accesses
 * `choices[0].delta.content` without guarding `delta` itself — a chunk whose
 * first choice lacks `delta` throws TypeError, which the consuming generator's
 * try/catch converts into an `error` event (pre-existing behavior preserved).
 */
export function mapOpenAiChunk(chunk: OpenAiStreamChunk): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];

  const choices = chunk.choices;
  if (!choices || choices.length === 0) return events;

  const delta = choices[0].delta;
  if (delta.content) {
    events.push({ type: "text_delta", text: delta.content });
  }

  if (choices[0].finish_reason) {
    const usage = chunk.usage;
    events.push({
      type: "finish",
      stopReason: choices[0].finish_reason === "length" ? "max_tokens" : "end_turn",
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
}

/**
 * Build the OpenAI-compatible request payload for `POST /chat/completions`
 * (pure function — extracted for unit testing).
 *
 * Key order (model, messages, stream, max_tokens?, temperature?) matches the
 * previous inline construction so `JSON.stringify` emits identical bytes.
 * `maxTokens`/`temperature` use `!== undefined` checks (0 is forwarded).
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

          for (const event of mapOpenAiChunk(parsed.chunk)) {
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

/**
 * Simple message converter (OpenAI-compatible format).
 *
 * Pure function — exported for unit testing. Behavior unchanged: optional
 * systemPrompt becomes a leading `system` message; per message, only `text`
 * segments are kept and joined with `\n`; messages whose joined text is
 * empty are dropped entirely.
 */
export function convertMessages(
  messages: ChatRequest["messages"],
  systemPrompt?: string
): { role: string; content: string }[] {
  const result: { role: string; content: string }[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const text = msg.content
      .filter((seg) => seg.type === "text")
      .map((seg) => (seg as { type: "text"; text: string }).text)
      .join("\n");
    if (text) {
      result.push({ role: msg.role, content: text });
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
