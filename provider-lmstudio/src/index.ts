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

/**
 * LM Studio Provider — OpenAI-compatible local inference server.
 */
class LmStudioProvider implements IProvider {
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

    const messages = convertMessages(request.messages, request.systemPrompt);

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    };

    if (request.maxTokens !== undefined) {
      payload.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

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
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          const choices = chunk.choices as
            | { delta: { content?: string }; finish_reason?: string }[]
            | undefined;
          if (!choices || choices.length === 0) continue;

          const delta = choices[0].delta;
          if (delta.content) {
            yield { type: "text_delta", text: delta.content };
          }

          if (choices[0].finish_reason) {
            const usage = chunk.usage as
              | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
              | undefined;
            yield {
              type: "finish",
              stopReason: choices[0].finish_reason === "length" ? "max_tokens" : "end_turn",
              usage: usage
                ? {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                  }
                : undefined,
            };
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
}

/**
 * Simple message converter (OpenAI-compatible format).
 */
function convertMessages(
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
