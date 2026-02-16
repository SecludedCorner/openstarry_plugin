/**
 * provider-gemini — Gemini LLM provider with API key authentication.
 *
 * Implements IPlugin and IProvider for the OpenStarry agent system.
 * Uses Google AI API (generativelanguage.googleapis.com) with API key in header.
 *
 * SECURITY: API keys are encrypted at rest using SecureStore (AES-256-GCM, machine-bound).
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

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODELS: ModelInfo[] = [
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    contextWindow: 2097152,
    maxOutputTokens: 8192,
  },
];

// ─── Types ───

interface StoredApiKey {
  apiKey: string;
}

interface GeminiMessage {
  role: "user" | "model";
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: { result: string } };
  }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiMessage[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

// ─── API Key Manager ───

class GeminiApiKeyManager {
  private storage: SecureStore;
  private apiKey: string | null = null;

  constructor(storage: SecureStore) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const stored = await this.storage.readSecure<StoredApiKey>("api_key.json");
    if (stored?.apiKey) {
      this.apiKey = stored.apiKey;
    }
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  async setApiKey(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    await this.storage.writeSecure("api_key.json", { apiKey });
  }

  async clearApiKey(): Promise<void> {
    this.apiKey = null;
    await this.storage.delete("api_key.json");
  }
}

// ─── Gemini API Streaming ───

async function* callGeminiStream(
  apiKey: string,
  model: string,
  request: GeminiRequest,
): AsyncGenerator<ProviderStreamEvent> {
  const endpoint = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    yield {
      type: "error",
      error: new Error(`Gemini API error: ${response.status} ${text}`),
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

  let pendingFunctionCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") {
          if (!hasYieldedFinish) {
            const stopReason =
              pendingFunctionCalls.length > 0 ? "tool_use" : "end_turn";
            yield {
              type: "finish",
              stopReason: stopReason as "end_turn" | "tool_use",
            };
            hasYieldedFinish = true;
          }
          continue;
        }

        try {
          const data = JSON.parse(jsonStr) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  text?: string;
                  functionCall?: {
                    name: string;
                    args: Record<string, unknown>;
                  };
                }>;
              };
              finishReason?: string;
            }>;
            error?: { message?: string };
          };

          if (data.error) {
            yield {
              type: "error",
              error: new Error(data.error.message ?? "Gemini API error"),
            };
            return;
          }

          if (data.candidates?.[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                yield { type: "text_delta", text: part.text };
              }
              if (part.functionCall) {
                const tcId = randomBytes(8).toString("hex");
                pendingFunctionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                });
                yield {
                  type: "tool_call_start",
                  toolCallId: tcId,
                  name: part.functionCall.name,
                };
                yield {
                  type: "tool_call_delta",
                  toolCallId: tcId,
                  input: JSON.stringify(part.functionCall.args),
                };
                yield {
                  type: "tool_call_end",
                  toolCallId: tcId,
                  name: part.functionCall.name,
                  input: JSON.stringify(part.functionCall.args),
                };
              }
            }
          }

          if (
            data.candidates?.[0]?.finishReason === "STOP" &&
            !hasYieldedFinish
          ) {
            yield { type: "finish", stopReason: "end_turn" };
            hasYieldedFinish = true;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try {
          const data = JSON.parse(jsonStr) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          if (data.candidates?.[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                yield { type: "text_delta", text: part.text };
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!hasYieldedFinish) {
      const stopReason =
        pendingFunctionCalls.length > 0 ? "tool_use" : "end_turn";
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
): {
  geminiMessages: GeminiMessage[];
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const geminiMessages: GeminiMessage[] = [];
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
        geminiMessages.push({
          role: "user",
          parts: texts.map((text) => ({ text })),
        });
      }
    } else if (msg.role === "assistant") {
      const parts: GeminiMessage["parts"] = [];
      for (const seg of msg.content) {
        if (seg.type === "text") {
          parts.push({ text: seg.text });
        } else if (seg.type === "tool_call") {
          parts.push({
            functionCall: {
              name: seg.toolCall.name,
              args: seg.toolCall.arguments,
            },
          });
        }
      }
      if (parts.length > 0) {
        geminiMessages.push({ role: "model", parts });
      }
    } else if (msg.role === "tool") {
      const parts: GeminiMessage["parts"] = [];
      for (const seg of msg.content) {
        if (seg.type === "tool_result") {
          parts.push({
            functionResponse: {
              name: seg.toolResult.name,
              response: { result: seg.toolResult.result },
            },
          });
        }
      }
      if (parts.length > 0) {
        geminiMessages.push({ role: "user", parts });
      }
    }
  }

  const systemInstruction = collectedSystemPrompt
    ? { parts: [{ text: collectedSystemPrompt }] }
    : undefined;

  return { geminiMessages, systemInstruction };
}

// ─── Provider Adapter ───

function createGeminiAdapter(keyManager: GeminiApiKeyManager): IProvider {
  return {
    id: "gemini",
    name: "Gemini (API Key)",
    models: MODELS,
    loginHint: { usage: "<API_KEY>", description: "Google AI", docUrl: "https://aistudio.google.com/app/apikey" },

    isConfigured(): boolean {
      return keyManager.isConfigured();
    },

    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const apiKey = keyManager.getApiKey();

      if (!apiKey) {
        yield {
          type: "error",
          error: new Error(
            "Not configured. Use /provider login gemini <API_KEY> to authenticate.\nRun /provider status to see all available providers.",
          ),
        };
        return;
      }

      const { geminiMessages, systemInstruction } = convertMessages(
        request.messages,
        request.systemPrompt,
      );

      let tools: GeminiRequest["tools"] = undefined;
      if (request.tools && request.tools.length > 0) {
        tools = [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ];
      }

      const geminiRequest: GeminiRequest = {
        contents: geminiMessages,
        systemInstruction,
        tools,
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
        },
      };

      yield* callGeminiStream(apiKey, request.model, geminiRequest);
    },
  };
}

// ─── Plugin Export ───

function getStoragePath(): string {
  return join(homedir(), ".openstarry", "plugins", "gemini");
}

export function createGeminiPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-gemini",
      version: "0.1.0-alpha",
      description: "Gemini LLM provider with API key authentication",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = getStoragePath();
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-provider-gemini",
      });
      await storage.ensureDir();

      const logger = createLogger("gemini");

      const keyManager = new GeminiApiKeyManager(storage);
      await keyManager.initialize();

      // Auto-configure from plugin config if not already configured
      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configApiKey = pluginConfig?.apiKey as string | undefined;
      if (!keyManager.isConfigured() && configApiKey) {
        await keyManager.setApiKey(configApiKey);
        logger.info("API key loaded from agent config.");
      }

      if (keyManager.isConfigured()) {
        logger.info(
          `Configured, ${MODELS.length} models available.`,
        );
      } else {
        logger.info(
          "Not configured. Use /provider login gemini <API_KEY>",
        );
      }

      const provider = createGeminiAdapter(keyManager);

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage providers (login/logout/status/remove)",
          async execute(args: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // ─── login gemini <API_KEY> ───
            if (subCmd === "login" && providerName === "gemini") {
              if (parts.length < 3) {
                return [
                  "Usage: /provider login gemini <API_KEY>",
                  "",
                  "Get your API key from:",
                  "  https://aistudio.google.com/app/apikey",
                ].join("\n");
              }

              const apiKey = parts[2];
              await keyManager.setApiKey(apiKey);
              return `Gemini API key configured. ${MODELS.length} models available.`;
            }

            // ─── logout gemini ───
            if (subCmd === "logout" && providerName === "gemini") {
              await keyManager.clearApiKey();
              return "Gemini API key cleared.";
            }

            // ─── remove gemini ───
            if (subCmd === "remove" && providerName === "gemini") {
              await keyManager.clearApiKey();
              return "Gemini API key removed.";
            }

            // Not handled by this plugin → pass to next handler
            return undefined;
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

export default createGeminiPlugin;
