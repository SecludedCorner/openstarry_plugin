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
import { SecureStore } from "@openstarry/shared";
import { streamChatCompletions } from "./api.js";
import { convertMessages, convertTools } from "./message-converter.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const MODELS: ModelInfo[] = [
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxOutputTokens: 16384 },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    contextWindow: 128000,
    maxOutputTokens: 16384,
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
  },
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    contextWindow: 128000,
    maxOutputTokens: 4096,
  },
  {
    id: "gpt-3.5-turbo",
    name: "GPT-3.5 Turbo",
    contextWindow: 16385,
    maxOutputTokens: 4096,
  },
];

interface StoredConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * ChatGPT Provider Implementation
 */
class ChatGptProvider implements IProvider {
  public readonly id = "chatgpt";
  public readonly name = "ChatGPT (OpenAI)";
  public readonly models = MODELS;
  public readonly loginHint = { usage: "<API_KEY>", description: "OpenAI" };

  public apiKey: string | null = null;
  public baseUrl: string = DEFAULT_BASE_URL;

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        error: new Error(
          "No API key configured. Use /provider login chatgpt <API_KEY> [BASE_URL] to set your key.\nRun /provider status to see all available providers.",
        ),
      };
      return;
    }

    const apiMessages = convertMessages(request.messages, request.systemPrompt);
    const apiTools = request.tools ? convertTools(request.tools) : undefined;

    yield* streamChatCompletions(
      this.apiKey,
      this.baseUrl,
      request.model,
      apiMessages,
      {
        tools: apiTools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
      }
    );
  }
}

/**
 * Create ChatGPT provider plugin
 */
export function createChatGptPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-chatgpt",
      version: "0.1.0-alpha",
      description: "OpenAI ChatGPT provider with streaming support",
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = join(homedir(), ".openstarry", "plugins", "chatgpt");
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-provider-chatgpt",
      });

      const provider = new ChatGptProvider();

      // Try to load existing config
      try {
        const config = await storage.readSecure<StoredConfig>("api-key.enc.json");
        if (config?.apiKey) {
          provider.apiKey = config.apiKey;
          provider.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
        }
      } catch {
        // No stored config or decryption failed
      }

      // Auto-configure from plugin config if not already configured
      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configApiKey = pluginConfig?.apiKey as string | undefined;
      if (!provider.apiKey && configApiKey) {
        provider.apiKey = configApiKey;
        provider.baseUrl = (pluginConfig?.baseUrl as string) || DEFAULT_BASE_URL;
        await storage.writeSecure("api-key.enc.json", { apiKey: provider.apiKey, baseUrl: provider.baseUrl });
      }

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage ChatGPT provider (login/logout/status/remove)",
          async execute(args: string, ctx: IPluginContext): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // /provider login chatgpt <API_KEY> [BASE_URL]
            if (
              subCmd === "login" &&
              (providerName === "chatgpt" || providerName === "openai")
            ) {
              if (parts.length < 3) {
                return "Usage: /provider login chatgpt <API_KEY> [BASE_URL]";
              }

              const apiKey = parts[2];
              const baseUrl = parts[3] || DEFAULT_BASE_URL;

              try {
                // Store config
                await storage.writeSecure("api-key.enc.json", { apiKey, baseUrl });

                // Update provider
                provider.apiKey = apiKey;
                provider.baseUrl = baseUrl;

                const modelList = MODELS.map((m) => `  - ${m.id}: ${m.name}`).join(
                  "\n"
                );
                return `ChatGPT provider configured successfully.\n\nBase URL: ${baseUrl}\n\nAvailable models:\n${modelList}`;
              } catch (error) {
                return `Failed to configure ChatGPT provider: ${error instanceof Error ? error.message : String(error)}`;
              }
            }

            // /provider logout chatgpt
            if (
              subCmd === "logout" &&
              (providerName === "chatgpt" || providerName === "openai")
            ) {
              try {
                await storage.delete("api-key.enc.json");
                provider.apiKey = null;
                provider.baseUrl = DEFAULT_BASE_URL;
                return "ChatGPT provider logged out successfully.";
              } catch (error) {
                return `Failed to logout: ${error instanceof Error ? error.message : String(error)}`;
              }
            }

            // /provider remove chatgpt
            if (
              subCmd === "remove" &&
              (providerName === "chatgpt" || providerName === "openai")
            ) {
              try {
                await storage.delete("api-key.enc.json");
                provider.apiKey = null;
                provider.baseUrl = DEFAULT_BASE_URL;
                return "ChatGPT provider removed successfully.";
              } catch (error) {
                return `Failed to remove provider: ${error instanceof Error ? error.message : String(error)}`;
              }
            }

            // Not handled by this plugin → pass to next handler
            return undefined;
          },
        },
      ];

      return {
        providers: [provider],
        commands,
        dispose: async () => {
          // Cleanup if needed
        },
      };
    },
  };
}

export default createChatGptPlugin;
