/**
 * provider-claude — Anthropic Claude provider using Messages API.
 *
 * Implements IPlugin and IProvider for the OpenStarry agent system.
 * Uses Anthropic Messages API with SecureStore encrypted API key storage.
 */

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
  SlashCommand,
} from "@openstarry/sdk";
import { SecureStore, createLogger } from "@openstarry/shared";
import { convertMessages } from "./message-converter.js";
import { streamClaudeMessages } from "./api.js";

// ─── Constants ───

const MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
    maxOutputTokens: 16384,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200000,
    maxOutputTokens: 16384,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
];

// ─── Types ───

interface ApiKeyData {
  apiKey: string;
}

// ─── API Key Manager ───

class ClaudeKeyManager {
  private storage: SecureStore;
  private apiKey: string | null = null;

  constructor(storage: SecureStore) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const saved = await this.storage.readSecure<ApiKeyData>("api-key.enc.json");
    if (saved?.apiKey) {
      this.apiKey = saved.apiKey;
    }
  }

  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  async setApiKey(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    await this.storage.writeSecure("api-key.enc.json", { apiKey });
  }

  async clearApiKey(): Promise<void> {
    this.apiKey = null;
    await this.storage.delete("api-key.enc.json");
  }
}

// ─── Provider Adapter ───

function createClaudeAdapter(keyManager: ClaudeKeyManager): IProvider {
  return {
    id: "claude",
    name: "Anthropic Claude",
    models: MODELS,
    loginHint: { usage: "<API_KEY>", description: "Anthropic", docUrl: "https://console.anthropic.com/" },

    isConfigured(): boolean {
      return keyManager.hasApiKey();
    },

    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const apiKey = keyManager.getApiKey();

      if (!apiKey) {
        yield {
          type: "error",
          error: new Error(
            "No API key configured. Use /provider login claude <API_KEY> to set your key.\nRun /provider status to see all available providers.",
          ),
        };
        return;
      }

      const { system, messages, tools } = convertMessages(
        request.messages,
        request.systemPrompt,
        request.tools,
      );

      const claudeRequest = {
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        system,
        messages,
        tools,
        temperature: request.temperature,
        stream: true as const,
      };

      yield* streamClaudeMessages(apiKey, claudeRequest, request.signal);
    },
  };
}

// ─── Plugin Export ───

function getStoragePath(): string {
  return join(homedir(), ".openstarry", "plugins", "claude");
}

export function createClaudePlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-claude",
      version: "0.1.0-alpha",
      description: "Anthropic Claude provider using Messages API",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = getStoragePath();
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-provider-claude",
      });
      await storage.ensureDir();

      const logger = createLogger("claude");

      const keyManager = new ClaudeKeyManager(storage);
      await keyManager.initialize();

      // Auto-configure from plugin config if not already configured
      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configApiKey = pluginConfig?.apiKey as string | undefined;
      if (!keyManager.hasApiKey() && configApiKey) {
        await keyManager.setApiKey(configApiKey);
        logger.info("API key loaded from agent config.");
      }

      if (keyManager.hasApiKey()) {
        logger.info(
          `API key configured, ${MODELS.length} models available.`,
        );
      } else {
        logger.info(
          "Not configured. Use /provider login claude <API_KEY>",
        );
      }

      const provider = createClaudeAdapter(keyManager);

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage Claude provider (login/logout/status/remove)",
          async execute(args: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // ─── login claude <API_KEY> ───
            if (subCmd === "login" && providerName === "claude") {
              if (parts.length < 3) {
                return [
                  "Usage: /provider login claude <API_KEY>",
                  "",
                  "Get your API key from: https://console.anthropic.com/",
                ].join("\n");
              }

              const apiKey = parts[2];
              if (!apiKey.startsWith("sk-ant-")) {
                return "Invalid API key format. Anthropic API keys start with 'sk-ant-'";
              }

              await keyManager.setApiKey(apiKey);
              return [
                "Claude API key saved successfully.",
                `Available models: ${MODELS.map((m) => m.id).join(", ")}`,
              ].join("\n");
            }

            // ─── logout claude ───
            if (subCmd === "logout" && providerName === "claude") {
              await keyManager.clearApiKey();
              return "Claude API key removed.";
            }

            // ─── remove claude ───
            if (subCmd === "remove" && providerName === "claude") {
              await keyManager.clearApiKey();
              return "Claude API key removed.";
            }

            // Not handled by this plugin → pass to next handler
            return undefined;
          },
        },
      ];

      return {
        providers: [provider],
        commands,
      };
    },
  };
}

export default createClaudePlugin;
