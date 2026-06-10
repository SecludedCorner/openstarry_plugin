/**
 * Sampling handler — Server requests LLM completion from client.
 */
import { randomUUID } from "node:crypto";
import type { IPluginContext, IProvider, Message } from "@openstarry/sdk";
import { AgentEventType, McpError } from "@openstarry/sdk";
import { createLogger } from "@openstarry/shared";
import type {
  SamplingRequest,
  SamplingResponse,
  McpContent,
  SamplingMessage,
  ModelPreferences,
} from "@openstarry-plugin/mcp-common";
import { McpErrorCode } from "@openstarry-plugin/mcp-common";

const logger = createLogger("mcp-client:sampling");

export class SamplingHandler {
  private maxDepth = 5; // Anti-recursion guard
  private rateLimiter = new Map<string, { count: number; resetAt: number }>();
  private maxSamplingPerMinute = 10;

  constructor(
    private ctx: IPluginContext,
    private serverName: string,
  ) {}

  async handleSamplingRequest(
    params: SamplingRequest,
    traceId: string,
    depth: number,
  ): Promise<SamplingResponse> {
    // 1. Rate limit check
    this.checkRateLimit(this.serverName);

    // 2. Depth guard
    if (depth > this.maxDepth) {
      this.ctx.bus.emit({
        type: AgentEventType.MCP_SAMPLING_DEPTH_LIMIT,
        timestamp: Date.now(),
        payload: { serverName: this.serverName, traceId, depth, limit: this.maxDepth },
      });
      throw new McpError(this.serverName, "Sampling depth limit exceeded", {
        code: McpErrorCode.SAMPLING_DEPTH_EXCEEDED.toString(),
      });
    }

    // 3. Emit sampling request event
    this.ctx.bus.emit({
      type: AgentEventType.MCP_SAMPLING_REQUEST,
      timestamp: Date.now(),
      payload: {
        serverName: this.serverName,
        traceId,
        depth,
        messageCount: params.messages.length,
      },
    });

    // 4. Resolve provider from model hints
    const providers = this.ctx.providers?.list() ?? [];
    if (providers.length === 0) {
      this.ctx.bus.emit({
        type: AgentEventType.MCP_SAMPLING_ERROR,
        timestamp: Date.now(),
        payload: {
          serverName: this.serverName,
          traceId,
          error: "No LLM provider available",
        },
      });
      throw new McpError(this.serverName, "No LLM provider available", {
        code: McpErrorCode.SAMPLING_PROVIDER_UNAVAILABLE.toString(),
      });
    }

    const provider = this.resolveProvider(params.modelPreferences, providers);
    const model = this.selectModel(provider, params.modelPreferences);

    // 5. Convert MCP messages to SDK format
    const messages = this.convertMcpMessages(params.messages);

    // 6. Invoke provider.chat() and accumulate response
    let fullText = "";
    let stopReason: "end_turn" | "stop_sequence" | "max_tokens" | undefined;

    try {
      for await (const event of provider.chat({
        model,
        messages,
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      })) {
        if (event.type === "text_delta") {
          fullText += event.text;
        } else if (event.type === "finish") {
          // Map provider stop reasons to MCP stop reasons
          if (event.stopReason === "end_turn" || event.stopReason === "tool_use") {
            stopReason = "end_turn";
          } else if (event.stopReason === "max_tokens") {
            stopReason = "max_tokens";
          } else if (event.stopReason === "error") {
            stopReason = "end_turn"; // Map error to end_turn as fallback
          }
        }
      }
    } catch (err) {
      this.ctx.bus.emit({
        type: AgentEventType.MCP_SAMPLING_ERROR,
        timestamp: Date.now(),
        payload: {
          serverName: this.serverName,
          traceId,
          error: String(err),
        },
      });
      throw new McpError(this.serverName, "Provider invocation failed", {
        code: McpErrorCode.SAMPLING_PROVIDER_UNAVAILABLE.toString(),
      });
    }

    // 7. Emit success event
    this.ctx.bus.emit({
      type: AgentEventType.MCP_SAMPLING_RESPONSE,
      timestamp: Date.now(),
      payload: {
        serverName: this.serverName,
        traceId,
        model,
        tokenCount: fullText.length, // Approximate
      },
    });

    // 8. Return sampling response
    return {
      role: "assistant",
      content: { type: "text", text: fullText },
      model,
      stopReason,
    };
  }

  private resolveProvider(
    modelPrefs: ModelPreferences | undefined,
    providers: IProvider[],
  ): IProvider {
    // Try to match model hints
    if (modelPrefs?.hints) {
      for (const hint of modelPrefs.hints) {
        if (!hint.name) continue;
        for (const provider of providers) {
          const match = provider.models.find((m) =>
            m.id.toLowerCase().includes(hint.name!.toLowerCase())
          );
          if (match) {
            logger.debug("Resolved provider from hint", {
              hint: hint.name,
              provider: provider.id,
            });
            return provider;
          }
        }
      }
    }

    // Fallback to first provider
    logger.debug("Using fallback provider", { provider: providers[0].id });
    return providers[0];
  }

  private selectModel(
    provider: IProvider,
    modelPrefs: ModelPreferences | undefined,
  ): string {
    // Try to match hints to provider models
    if (modelPrefs?.hints) {
      for (const hint of modelPrefs.hints) {
        if (!hint.name) continue;
        const match = provider.models.find((m) =>
          m.id.toLowerCase().includes(hint.name!.toLowerCase())
        );
        if (match) {
          logger.debug("Selected model from hint", {
            hint: hint.name,
            model: match.id,
          });
          return match.id;
        }
      }
    }

    // Fallback to first model
    const fallbackModel = provider.models[0]?.id || "unknown";
    logger.debug("Using fallback model", { model: fallbackModel });
    return fallbackModel;
  }

  private convertMcpMessages(mcpMessages: SamplingMessage[]): Message[] {
    return mcpMessages.map((msg, index) => {
      const text = this.extractTextContent(msg.content);
      return {
        id: randomUUID(),
        role: msg.role === "system" ? "system" : msg.role === "user" ? "user" : "assistant",
        content: [{ type: "text", text }],
        createdAt: Date.now() + index, // Add index to avoid duplicate timestamps
      };
    });
  }

  private checkRateLimit(serverName: string): void {
    const now = Date.now();
    const entry = this.rateLimiter.get(serverName);

    if (!entry || now > entry.resetAt) {
      this.rateLimiter.set(serverName, { count: 1, resetAt: now + 60000 });
      return;
    }

    if (entry.count >= this.maxSamplingPerMinute) {
      throw new McpError(serverName, "Sampling rate limit exceeded", {
        code: "-32000",
      });
    }

    entry.count++;
  }

  private extractTextContent(content: McpContent): string {
    if (content.type === "text") return content.text;
    if (content.type === "resource" && content.text) return content.text;
    return "[non-text content]";
  }
}
