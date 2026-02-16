/**
 * provider-local-llama — Ollama LLM provider (local models).
 *
 * Implements IPlugin and IProvider for the OpenStarry agent system.
 * Auto-detects Ollama at http://127.0.0.1:11434 on startup.
 *
 * NDJSON streaming (not SSE) — each line is a JSON object.
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

interface OllamaChatRequest {
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

interface OllamaChatChunk {
  model: string;
  message?: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
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

// ─── Ollama API Streaming ───

async function* callOllamaStream(
  hostUrl: string,
  model: string,
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
  let hasYieldedFinish = false;
  let pendingToolCalls = false;

  const toolCallMap = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as OllamaChatChunk;

          if (chunk.message?.content && chunk.message.content.length > 0) {
            yield { type: "text_delta", text: chunk.message.content };
          }

          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            pendingToolCalls = true;
            for (const tc of chunk.message.tool_calls) {
              const tcId = randomBytes(8).toString("hex");
              toolCallMap.set(tcId, {
                name: tc.function.name,
                args: tc.function.arguments,
              });

              yield {
                type: "tool_call_start",
                toolCallId: tcId,
                name: tc.function.name,
              };
              yield {
                type: "tool_call_delta",
                toolCallId: tcId,
                input: JSON.stringify(tc.function.arguments),
              };
              yield {
                type: "tool_call_end",
                toolCallId: tcId,
                name: tc.function.name,
                input: JSON.stringify(tc.function.arguments),
              };
            }
          }

          if (chunk.done && !hasYieldedFinish) {
            const stopReason = pendingToolCalls ? "tool_use" : "end_turn";
            yield {
              type: "finish",
              stopReason: stopReason as "end_turn" | "tool_use",
              usage: chunk.eval_count
                ? {
                    promptTokens: chunk.prompt_eval_count ?? 0,
                    completionTokens: chunk.eval_count,
                  }
                : undefined,
            };
            hasYieldedFinish = true;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as OllamaChatChunk;
        if (chunk.message?.content && chunk.message.content.length > 0) {
          yield { type: "text_delta", text: chunk.message.content };
        }
        if (chunk.done && !hasYieldedFinish) {
          const stopReason = pendingToolCalls ? "tool_use" : "end_turn";
          yield {
            type: "finish",
            stopReason: stopReason as "end_turn" | "tool_use",
          };
          hasYieldedFinish = true;
        }
      } catch {
        // Ignore
      }
    }

    if (!hasYieldedFinish) {
      const stopReason = pendingToolCalls ? "tool_use" : "end_turn";
      yield {
        type: "finish",
        stopReason: stopReason as "end_turn" | "tool_use",
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

function convertMessages(
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

// ─── Provider Adapter ───

function createOllamaAdapter(manager: OllamaManager): IProvider {
  return {
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

      const ollamaRequest: OllamaChatRequest = {
        model: request.model,
        messages,
        stream: true,
        options: {
          temperature: request.temperature,
        },
        tools,
      };

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
