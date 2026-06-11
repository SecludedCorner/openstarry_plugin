/**
 * provider-local-llama — Ollama LLM provider (local models).
 *
 * Implements IPlugin and IProvider for the OpenStarry agent system.
 * Auto-detects Ollama at http://127.0.0.1:11434 on startup.
 *
 * NDJSON streaming (not SSE) — each line is a JSON object.
 *
 * **2026-06-12 hardening (task #21 地端硬化)**: stream mapping extracted into
 * pure named exports (`parseOllamaLine` / `mapOllamaChunk` / `mapStopReason` /
 * `buildOllamaPayload` / `convertMessages`) following the provider-claude-cli
 * idiom (buildArgv / mapStreamEvent pattern) so the NDJSON wire protocol is
 * unit-testable without a live Ollama. The three formerly-duplicated
 * finish-yield sites (main loop / final-buffer remnant / no-done fallback)
 * are consolidated into ONE mapper code path; the `hasYieldedFinish` dedup
 * guard lives in `OllamaStreamState` and survives across all sites.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  IPlugin,
  IPluginContext,
  IProvider,
  PluginHooks,
  ChatRequest,
  ProviderStreamEvent,
  ModelInfo,
  Message,
  SlashCommand,
  ContentSegment,
} from "@openstarry/sdk";
import { SecureStore, createLogger } from "@openstarry/shared";

// ─── Constants ───

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const OLLAMA_DETECT_TIMEOUT = 5000; // 5 seconds

// ─── Types ───

interface StoredConfig {
  hostUrl: string;
}

interface OllamaModelEntry {
  name: string;
  size?: number;
  modified_at?: string;
}

interface OllamaTagsResponse {
  models: OllamaModelEntry[];
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
  };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
}

export interface OllamaChatChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ─── Ollama Manager ───

class OllamaManager {
  private storage: SecureStore;
  private hostUrl: string = DEFAULT_OLLAMA_HOST;
  private models: ModelInfo[] = [];
  private isConnected: boolean = false;

  constructor(storage: SecureStore) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const stored = await this.storage.read<StoredConfig>("config.json");
    if (stored?.hostUrl) {
      this.hostUrl = stored.hostUrl;
    }

    await this.detectModels();
  }

  async detectModels(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        OLLAMA_DETECT_TIMEOUT,
      );

      const response = await fetch(`${this.hostUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this.isConnected = false;
        this.models = [];
        return;
      }

      const data = (await response.json()) as OllamaTagsResponse;
      this.models = data.models.map((m) => ({
        id: m.name,
        name: m.name,
        contextWindow: 8192, // Default — Ollama doesn't report this
        maxOutputTokens: 4096,
      }));
      this.isConnected = true;
    } catch {
      this.isConnected = false;
      this.models = [];
    }
  }

  getHostUrl(): string {
    return this.hostUrl;
  }

  async setHostUrl(hostUrl: string): Promise<void> {
    this.hostUrl = hostUrl;
    await this.storage.write("config.json", { hostUrl });
    await this.detectModels();
  }

  async resetHostUrl(): Promise<void> {
    this.hostUrl = DEFAULT_OLLAMA_HOST;
    await this.storage.delete("config.json");
    await this.detectModels();
  }

  getModels(): ModelInfo[] {
    return this.models;
  }

  isOllamaConnected(): boolean {
    return this.isConnected;
  }
}

// ─── Pure stream mapping (extracted 2026-06-12 hardening) ───

/**
 * Per-stream mutable state threaded through `mapOllamaChunk` (claude-cli
 * `StreamMapState` pattern). Carries the finish-dedup guard and the
 * tool-presence flag that decides the final `stopReason`.
 */
export interface OllamaStreamState {
  /** True once a `finish` event has been emitted for this stream. */
  hasYieldedFinish: boolean;
  /** True once any chunk in this stream carried tool_calls. */
  pendingToolCalls: boolean;
}

/** Fresh per-stream state. One per `callOllamaStream` invocation. */
export function createOllamaStreamState(): OllamaStreamState {
  return { hasYieldedFinish: false, pendingToolCalls: false };
}

/**
 * Parse one NDJSON line into an OllamaChatChunk.
 *
 * Returns null for blank lines and malformed JSON — preserving the legacy
 * "malformed NDJSON silently skipped" wire behaviour (the stream stays
 * alive; one bad line never kills inference).
 */
export function parseOllamaLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaChatChunk;
  } catch {
    return null; // Ignore parse errors (legacy behaviour)
  }
}

/**
 * Map the tool-presence flag to the finish stopReason.
 * Tool calls anywhere in the stream → "tool_use"; otherwise "end_turn".
 */
export function mapStopReason(
  pendingToolCalls: boolean,
): "end_turn" | "tool_use" {
  return pendingToolCalls ? "tool_use" : "end_turn";
}

/** Default tool-call id generator — 8 random bytes hex (16 chars). */
function genDefaultToolCallId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Map a single parsed Ollama chunk to zero-or-more ProviderStreamEvents.
 *
 * THE single mapping code path — the streaming loop, the final-buffer
 * remnant flush and (via `mapStopReason`) the no-done fallback all route
 * through here, replacing the three formerly-duplicated finish-yield sites.
 *
 * Semantics preserved from the legacy inline loop:
 *   - `message.content` (non-empty) → one `text_delta`.
 *   - each `message.tool_calls[]` entry → `tool_call_start` /
 *     `tool_call_delta` / `tool_call_end` triplet sharing one random hex id;
 *     `input` = JSON.stringify of the arguments object on both delta + end.
 *   - `done: true` → one `finish` (dedup-guarded by `state.hasYieldedFinish`);
 *     `stopReason` = "tool_use" iff any tool_calls were seen earlier in the
 *     stream; `usage` mapped from `prompt_eval_count` / `eval_count` only
 *     when `eval_count` is truthy (legacy: 0 / absent → usage undefined).
 *
 * @param genToolCallId test seam — injectable id generator (defaults to
 *   crypto randomBytes; production call sites never pass it).
 */
export function mapOllamaChunk(
  chunk: OllamaChatChunk,
  state: OllamaStreamState,
  genToolCallId: () => string = genDefaultToolCallId,
): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];

  if (chunk.message?.content && chunk.message.content.length > 0) {
    events.push({ type: "text_delta", text: chunk.message.content });
  }

  if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
    state.pendingToolCalls = true;
    for (const tc of chunk.message.tool_calls) {
      const tcId = genToolCallId();
      const input = JSON.stringify(tc.function.arguments);
      events.push({
        type: "tool_call_start",
        toolCallId: tcId,
        name: tc.function.name,
      });
      events.push({
        type: "tool_call_delta",
        toolCallId: tcId,
        input,
      });
      events.push({
        type: "tool_call_end",
        toolCallId: tcId,
        name: tc.function.name,
        input,
      });
    }
  }

  if (chunk.done && !state.hasYieldedFinish) {
    events.push({
      type: "finish",
      stopReason: mapStopReason(state.pendingToolCalls),
      usage: chunk.eval_count
        ? {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count,
          }
        : undefined,
    });
    state.hasYieldedFinish = true;
  }

  return events;
}

// ─── Ollama API Streaming ───

/**
 * POST {hostUrl}/api/chat and stream ProviderStreamEvents from the NDJSON
 * response. Exported for integration testing with a stubbed global fetch.
 *
 * Error paths (wire-identical to the legacy implementation):
 *   - HTTP !ok        → `error` event `Ollama API error: <status> <body>`
 *   - missing body    → `error` event `No response body`
 *   - mid-stream read failure → `error` event with the underlying Error
 *   - fetch rejection (e.g. connection refused) propagates as a generator
 *     rejection (NOT an error event) — legacy behaviour preserved.
 *
 * @param _model retained for call-site compatibility; the model travels
 *   inside `request.model` (legacy signature had the same unused param).
 */
export async function* callOllamaStream(
  hostUrl: string,
  _model: string,
  request: OllamaChatRequest,
): AsyncGenerator<ProviderStreamEvent> {
  const endpoint = `${hostUrl}/api/chat`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    yield {
      type: "error",
      error: new Error(`Ollama API error: ${response.status} ${text}`),
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
  const state = createOllamaStreamState();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const chunk = parseOllamaLine(line);
        if (chunk === null) continue;
        yield* mapOllamaChunk(chunk, state);
      }
    }

    // Final-buffer remnant (stream ended without trailing newline) — same
    // single mapper path as the main loop (consolidated 2026-06-12; the
    // legacy inline remnant handler dropped usage and ignored tool_calls).
    const remnant = parseOllamaLine(buffer);
    if (remnant !== null) {
      yield* mapOllamaChunk(remnant, state);
    }

    // Defensive close: stream ended without any done:true chunk.
    if (!state.hasYieldedFinish) {
      yield {
        type: "finish",
        stopReason: mapStopReason(state.pendingToolCalls),
      };
    }
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// ─── Message Conversion ───

/**
 * Convert OpenStarry messages (+ optional systemPrompt) into Ollama chat
 * messages. Pure function — exported for unit testing.
 *
 * Semantics (legacy-preserved):
 *   - `system` messages collect their text and OVERRIDE the systemPrompt
 *     parameter (last system message wins); emitted as a single prepended
 *     `system` message.
 *   - `user` / `assistant` text segments join with "\n"; empty-text
 *     messages are dropped.
 *   - assistant `tool_call` segments map to Ollama `tool_calls` (the
 *     assistant message is kept even when its text is empty).
 *   - `tool` messages join their `tool_result` payloads with "\n".
 */
export function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): OllamaMessage[] {
  const ollamaMessages: OllamaMessage[] = [];
  let collectedSystemPrompt = systemPrompt;

  for (const msg of messages) {
    if (msg.role === "system") {
      const texts = msg.content
        .filter(
          (c): c is ContentSegment & { type: "text" } => c.type === "text",
        )
        .map((c) => c.text);
      if (texts.length > 0) {
        collectedSystemPrompt = texts.join("\n");
      }
      continue;
    }

    if (msg.role === "user") {
      const texts = msg.content
        .filter(
          (c): c is ContentSegment & { type: "text" } => c.type === "text",
        )
        .map((c) => c.text);
      if (texts.length > 0) {
        ollamaMessages.push({
          role: "user",
          content: texts.join("\n"),
        });
      }
    } else if (msg.role === "assistant") {
      const texts = msg.content
        .filter(
          (c): c is ContentSegment & { type: "text" } => c.type === "text",
        )
        .map((c) => c.text);
      const toolCalls = msg.content.filter(
        (c): c is ContentSegment & { type: "tool_call" } =>
          c.type === "tool_call",
      );

      if (toolCalls.length > 0) {
        ollamaMessages.push({
          role: "assistant",
          content: texts.join("\n"),
          tool_calls: toolCalls.map((tc) => ({
            function: {
              name: tc.toolCall.name,
              arguments: tc.toolCall.arguments,
            },
          })),
        });
      } else if (texts.length > 0) {
        ollamaMessages.push({
          role: "assistant",
          content: texts.join("\n"),
        });
      }
    } else if (msg.role === "tool") {
      const results = msg.content.filter(
        (c): c is ContentSegment & { type: "tool_result" } =>
          c.type === "tool_result",
      );
      if (results.length > 0) {
        ollamaMessages.push({
          role: "tool",
          content: results.map((r) => r.toolResult.result).join("\n"),
        });
      }
    }
  }

  // Prepend system message if present
  if (collectedSystemPrompt) {
    ollamaMessages.unshift({
      role: "system",
      content: collectedSystemPrompt,
    });
  }

  return ollamaMessages;
}

/**
 * Build the Ollama /api/chat payload from an OpenStarry ChatRequest.
 * Pure function — exported for unit testing.
 *
 * Legacy-preserved details: `stream` always true; `options.temperature`
 * forwarded as-is (undefined temperature keeps `options: {}` on the wire
 * after JSON.stringify); `tools` only present when the request carries a
 * non-empty tool list.
 */
export function buildOllamaPayload(request: ChatRequest): OllamaChatRequest {
  const messages = convertMessages(request.messages, request.systemPrompt);

  let tools: OllamaChatRequest["tools"] = undefined;
  if (request.tools && request.tools.length > 0) {
    tools = request.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  return {
    model: request.model,
    messages,
    stream: true,
    options: {
      temperature: request.temperature,
    },
    tools,
  };
}

// ─── Provider Adapter ───

function createOllamaAdapter(manager: OllamaManager): IProvider {
  return {
    skandha: 'samjna' as const,
    id: "ollama",
    name: "Ollama (Local LLM)",
    models: manager.getModels(),
    loginHint: { usage: "", description: "Ollama local" },

    isConfigured(): boolean {
      return manager.isOllamaConnected();
    },

    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      if (!manager.isOllamaConnected()) {
        yield {
          type: "error",
          error: new Error(
            "Ollama not detected. Ensure Ollama is running at " +
              manager.getHostUrl() +
              "\nRun /provider status to see all available providers.",
          ),
        };
        return;
      }

      const ollamaRequest = buildOllamaPayload(request);

      yield* callOllamaStream(
        manager.getHostUrl(),
        request.model,
        ollamaRequest,
      );
    },
  };
}

// ─── Plugin Export ───

function getStoragePath(): string {
  return join(homedir(), ".openstarry", "plugins", "local-llama");
}

export function createLocalLlamaPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-local-llama",
      version: "0.1.0-alpha",
      description: "Ollama LLM provider (local models)",
      skandha: 'samjna' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = getStoragePath();
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-provider-local-llama",
      });
      await storage.ensureDir();

      const logger = createLogger("ollama");

      // Apply hostUrl from plugin config before initialize
      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configHostUrl = pluginConfig?.hostUrl as string | undefined;
      if (configHostUrl) {
        await storage.write("config.json", { hostUrl: configHostUrl });
      }

      const manager = new OllamaManager(storage);
      await manager.initialize();

      if (manager.isOllamaConnected()) {
        const modelCount = manager.getModels().length;
        logger.info(
          `Connected to ${manager.getHostUrl()}, ${modelCount} models available.`,
        );
      } else {
        logger.info(
          `Not detected at ${manager.getHostUrl()}. Use /provider login ollama to retry.`,
        );
      }

      const provider = createOllamaAdapter(manager);

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage providers (login/logout/status/remove)",
          async execute(args: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // ─── login ollama [HOST_URL] ───
            if (subCmd === "login" && providerName === "ollama") {
              if (parts.length >= 3) {
                const hostUrl = parts[2];
                await manager.setHostUrl(hostUrl);
              } else {
                await manager.detectModels();
              }

              if (manager.isOllamaConnected()) {
                const modelCount = manager.getModels().length;
                const models = manager
                  .getModels()
                  .map((m) => m.id)
                  .join(", ");
                return [
                  `Connected to Ollama at ${manager.getHostUrl()}`,
                  `Models (${modelCount}): ${models || "(none)"}`,
                ].join("\n");
              } else {
                return `Failed to connect to Ollama at ${manager.getHostUrl()}. Ensure Ollama is running.`;
              }
            }

            // ─── logout ollama ───
            if (subCmd === "logout" && providerName === "ollama") {
              await manager.resetHostUrl();
              return `Reset to default host: ${manager.getHostUrl()}`;
            }

            // ─── remove ollama ───
            if (subCmd === "remove" && providerName === "ollama") {
              await manager.resetHostUrl();
              return "Ollama configuration removed (reset to default host).";
            }

            // Not handled by this plugin → pass to next handler
            return undefined;
          },
        },
        {
          name: "ollama",
          description: "Ollama-specific commands",
          async execute(args: string): Promise<string> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];

            if (subCmd === "refresh") {
              await manager.detectModels();
              if (manager.isOllamaConnected()) {
                const modelCount = manager.getModels().length;
                const models = manager
                  .getModels()
                  .map((m) => m.id)
                  .join(", ");
                return [
                  `Refreshed model list from ${manager.getHostUrl()}`,
                  `Models (${modelCount}): ${models || "(none)"}`,
                ].join("\n");
              } else {
                return `Failed to connect to Ollama at ${manager.getHostUrl()}`;
              }
            }

            return [
              "Usage:",
              "  /ollama refresh  — Refresh model list from Ollama",
            ].join("\n");
          },
        },
      ];

      return {
        providers: [provider],
        commands,
        dispose() {},
      };
    },
  };
}

export default createLocalLlamaPlugin;
