import { describe, it, expect, vi, beforeEach } from "vitest";
import { SamplingHandler } from "./sampling-handler.js";
import type { IPluginContext, EventBus, IProvider } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { SamplingRequest } from "@openstarry-plugin/mcp-common";
import { McpErrorCode } from "@openstarry-plugin/mcp-common";

function makeMockCtx(): IPluginContext {
  return {
    bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() } as unknown as EventBus,
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {} as IPluginContext["sessions"],
  };
}

function makeMockProvider(id: string, modelIds: string[]): IProvider {
  return {
    id,
    name: `${id} Provider`,
    models: modelIds.map((mid) => ({ id: mid, name: mid })),
    chat: async function* (request) {
      yield { type: "text_delta", text: "Mock response from " };
      yield { type: "text_delta", text: id };
      yield { type: "finish", stopReason: "end_turn" };
    },
  };
}

function makeSamplingRequest(overrides: Partial<SamplingRequest> = {}): SamplingRequest {
  return {
    messages: [
      { role: "user", content: { type: "text", text: "Hello" } },
    ],
    ...overrides,
  };
}

describe("SamplingHandler", () => {
  let ctx: IPluginContext;
  let handler: SamplingHandler;

  beforeEach(() => {
    ctx = makeMockCtx();
    handler = new SamplingHandler(ctx, "test-server");
  });

  describe("depth guard", () => {
    it("should reject when depth exceeds limit (5)", async () => {
      const request = makeSamplingRequest();
      const traceId = "trace-123";

      await expect(handler.handleSamplingRequest(request, traceId, 6)).rejects.toThrow(
        "Sampling depth limit exceeded"
      );

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_DEPTH_LIMIT,
          payload: expect.objectContaining({
            serverName: "test-server",
            traceId: "trace-123",
            depth: 6,
            limit: 5,
          }),
        })
      );
    });

    it("should accept when depth equals limit (5)", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      // Should succeed with provider at depth limit
      const response = await handler.handleSamplingRequest(request, "trace-123", 5);
      expect(response.role).toBe("assistant");

      const depthLimitCalls = (ctx.bus.emit as any).mock.calls.filter(
        (call: any) => call[0].type === AgentEventType.MCP_SAMPLING_DEPTH_LIMIT
      );
      expect(depthLimitCalls).toHaveLength(0);
    });

    it("should accept when depth is below limit", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      // Should succeed with provider available
      const response = await handler.handleSamplingRequest(request, "trace-123", 3);
      expect(response.role).toBe("assistant");

      const depthLimitCalls = (ctx.bus.emit as any).mock.calls.filter(
        (call: any) => call[0].type === AgentEventType.MCP_SAMPLING_DEPTH_LIMIT
      );
      expect(depthLimitCalls).toHaveLength(0);
    });
  });

  describe("rate limiting", () => {
    it("should allow up to 10 requests per minute", async () => {
      const request = makeSamplingRequest();
      // No provider - will fail on provider unavailable
      ctx.providers = { list: () => [], get: () => undefined };

      // First 10 requests should pass rate limit (but fail on no provider)
      for (let i = 0; i < 10; i++) {
        await expect(handler.handleSamplingRequest(request, `trace-${i}`, 1)).rejects.toThrow(
          "No LLM provider available"
        );
      }

      // 11th request should hit rate limit
      await expect(handler.handleSamplingRequest(request, "trace-11", 1)).rejects.toThrow(
        "Sampling rate limit exceeded"
      );
    });

    it("should reset rate limit after 1 minute", async () => {
      const request = makeSamplingRequest();
      ctx.providers = { list: () => [], get: () => undefined };

      // Exhaust rate limit
      for (let i = 0; i < 10; i++) {
        await expect(handler.handleSamplingRequest(request, `trace-${i}`, 1)).rejects.toThrow();
      }

      // Next request should fail with rate limit
      await expect(handler.handleSamplingRequest(request, "trace-limit", 1)).rejects.toThrow(
        "Sampling rate limit exceeded"
      );

      // Simulate time passing (mock Date.now)
      const originalNow = Date.now;
      Date.now = vi.fn(() => originalNow() + 61000); // 61 seconds later

      // Should work again after reset
      await expect(handler.handleSamplingRequest(request, "trace-reset", 1)).rejects.toThrow(
        "No LLM provider available" // Not rate limit error
      );

      Date.now = originalNow;
    });
  });

  describe("SAMPLING_PROVIDER_UNAVAILABLE response", () => {
    it("should return error code -32003 when no provider available", async () => {
      const request = makeSamplingRequest();
      ctx.providers = { list: () => [], get: () => undefined };

      try {
        await handler.handleSamplingRequest(request, "trace-123", 1);
        expect.fail("Should have thrown error");
      } catch (err: any) {
        expect(err.message).toContain("No LLM provider available");
        expect(err.code).toBe(McpErrorCode.SAMPLING_PROVIDER_UNAVAILABLE.toString());
      }
    });

    it("should emit MCP_SAMPLING_ERROR event when no provider", async () => {
      const request = makeSamplingRequest();
      ctx.providers = { list: () => [], get: () => undefined };

      await expect(handler.handleSamplingRequest(request, "trace-123", 1)).rejects.toThrow();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_ERROR,
          payload: expect.objectContaining({
            serverName: "test-server",
            traceId: "trace-123",
            error: "No LLM provider available",
          }),
        })
      );
    });
  });

  describe("event emission", () => {
    it("should emit MCP_SAMPLING_REQUEST event", async () => {
      const request = makeSamplingRequest({
        messages: [
          { role: "user", content: { type: "text", text: "Message 1" } },
          { role: "assistant", content: { type: "text", text: "Message 2" } },
        ],
      });
      ctx.providers = { list: () => [], get: () => undefined };

      await expect(handler.handleSamplingRequest(request, "trace-456", 2)).rejects.toThrow();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_REQUEST,
          payload: expect.objectContaining({
            serverName: "test-server",
            traceId: "trace-456",
            depth: 2,
            messageCount: 2,
          }),
        })
      );
    });

    it("should emit events with valid timestamp", async () => {
      const request = makeSamplingRequest();
      ctx.providers = { list: () => [], get: () => undefined };
      const beforeTimestamp = Date.now();

      await expect(handler.handleSamplingRequest(request, "trace-123", 1)).rejects.toThrow();

      const afterTimestamp = Date.now();

      const emitCalls = (ctx.bus.emit as any).mock.calls;
      expect(emitCalls.length).toBeGreaterThan(0);

      for (const call of emitCalls) {
        expect(call[0].timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
        expect(call[0].timestamp).toBeLessThanOrEqual(afterTimestamp);
      }
    });
  });

  describe("valid sampling request format handling", () => {
    it("should handle request with all optional fields", async () => {
      const request = makeSamplingRequest({
        messages: [{ role: "user", content: { type: "text", text: "Test" } }],
        modelPreferences: {
          hints: [{ name: "claude-3" }],
          costPriority: 0.5,
          speedPriority: 0.8,
          intelligencePriority: 0.9,
        },
        systemPrompt: "You are a helpful assistant",
        includeContext: "thisServer",
        temperature: 0.7,
        maxTokens: 1024,
        stopSequences: ["STOP", "END"],
        metadata: { requestId: "req-123", source: "tool-execution" },
      });
      ctx.providers = {
        list: () => [makeMockProvider("test", ["claude-3-opus"])],
        get: () => undefined,
      };

      // Should succeed with provider
      const response = await handler.handleSamplingRequest(request, "trace-789", 1);
      expect(response.role).toBe("assistant");
    });

    it("should handle request with minimal fields", async () => {
      const request: SamplingRequest = {
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      };
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      const response = await handler.handleSamplingRequest(request, "trace-minimal", 1);
      expect(response.role).toBe("assistant");
    });

    it("should handle different message roles", async () => {
      const request = makeSamplingRequest({
        messages: [
          { role: "system", content: { type: "text", text: "System prompt" } },
          { role: "user", content: { type: "text", text: "User message" } },
          { role: "assistant", content: { type: "text", text: "Assistant message" } },
        ],
      });
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      await handler.handleSamplingRequest(request, "trace-roles", 1);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_REQUEST,
          payload: expect.objectContaining({
            messageCount: 3,
          }),
        })
      );
    });
  });

  describe("missing/invalid fields in request", () => {
    it("should handle empty messages array", async () => {
      const request = makeSamplingRequest({ messages: [] });
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      const response = await handler.handleSamplingRequest(request, "trace-empty", 1);
      expect(response.role).toBe("assistant");

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_REQUEST,
          payload: expect.objectContaining({
            messageCount: 0,
          }),
        })
      );
    });

    it("should handle resource content type", async () => {
      const request = makeSamplingRequest({
        messages: [
          {
            role: "user",
            content: {
              type: "resource",
              uri: "file:///test.txt",
              text: "Resource content",
            },
          },
        ],
      });
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      // Should not throw parsing error
      const response = await handler.handleSamplingRequest(request, "trace-resource", 1);
      expect(response.role).toBe("assistant");
    });

    it("should handle image content type", async () => {
      const request = makeSamplingRequest({
        messages: [
          {
            role: "user",
            content: {
              type: "image",
              data: "base64data",
              mimeType: "image/png",
            } as any, // Image type exists in McpContent
          },
        ],
      });
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      // Should not throw parsing error
      const response = await handler.handleSamplingRequest(request, "trace-image", 1);
      expect(response.role).toBe("assistant");
    });
  });

  describe("depth tracking", () => {
    it("should pass depth parameter correctly in events", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      await handler.handleSamplingRequest(request, "trace-depth", 3);

      const requestEvent = (ctx.bus.emit as any).mock.calls.find(
        (call: any) => call[0].type === AgentEventType.MCP_SAMPLING_REQUEST
      );

      expect(requestEvent[0].payload.depth).toBe(3);
    });

    it("should reject at exactly maxDepth + 1", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      // Should fail at depth 6
      await expect(handler.handleSamplingRequest(request, "trace-limit", 6)).rejects.toThrow(
        "Sampling depth limit exceeded"
      );

      // Should pass at depth 5 with provider
      const response = await handler.handleSamplingRequest(request, "trace-ok", 5);
      expect(response.role).toBe("assistant");
    });
  });

  describe("trace ID propagation", () => {
    it("should include trace ID in all emitted events", async () => {
      const request = makeSamplingRequest();
      const traceId = "trace-unique-id-123";
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      await handler.handleSamplingRequest(request, traceId, 1);

      const emitCalls = (ctx.bus.emit as any).mock.calls;

      for (const call of emitCalls) {
        if (call[0].payload?.traceId !== undefined) {
          expect(call[0].payload.traceId).toBe(traceId);
        }
      }
    });

    it("should propagate different trace IDs for different requests", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      await handler.handleSamplingRequest(request, "trace-001", 1);
      await handler.handleSamplingRequest(request, "trace-002", 1);

      const requestEvents = (ctx.bus.emit as any).mock.calls.filter(
        (call: any) => call[0].type === AgentEventType.MCP_SAMPLING_REQUEST
      );

      expect(requestEvents[0][0].payload.traceId).toBe("trace-001");
      expect(requestEvents[1][0].payload.traceId).toBe("trace-002");
    });
  });

  describe("server name tracking", () => {
    it("should include server name in all events", async () => {
      const request = makeSamplingRequest();
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };

      await handler.handleSamplingRequest(request, "trace-123", 1);

      const emitCalls = (ctx.bus.emit as any).mock.calls;

      for (const call of emitCalls) {
        if (call[0].payload?.serverName !== undefined) {
          expect(call[0].payload.serverName).toBe("test-server");
        }
      }
    });

    it("should track different server names correctly", async () => {
      ctx.providers = {
        list: () => [makeMockProvider("test", ["test-model"])],
        get: () => undefined,
      };
      const handler1 = new SamplingHandler(ctx, "server-1");
      const handler2 = new SamplingHandler(ctx, "server-2");
      const request = makeSamplingRequest();

      await handler1.handleSamplingRequest(request, "trace-1", 1);
      await handler2.handleSamplingRequest(request, "trace-2", 1);

      const requestEvents = (ctx.bus.emit as any).mock.calls.filter(
        (call: any) => call[0].type === AgentEventType.MCP_SAMPLING_REQUEST
      );

      expect(requestEvents[0][0].payload.serverName).toBe("server-1");
      expect(requestEvents[1][0].payload.serverName).toBe("server-2");
    });
  });

  // ─── NEW TESTS: Provider Integration ───

  describe("provider resolution", () => {
    it("should resolve provider from model hints and return LLM response", async () => {
      const mockProvider: IProvider = {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "claude-3-opus", name: "Claude 3 Opus" }],
        chat: async function* () {
          yield { type: "text_delta", text: "Hello from " };
          yield { type: "text_delta", text: "Claude!" };
          yield { type: "finish", stopReason: "end_turn" };
        },
      };
      ctx.providers = {
        list: () => [mockProvider],
        get: (id) => (id === "anthropic" ? mockProvider : undefined),
      };

      const request = makeSamplingRequest({
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        modelPreferences: { hints: [{ name: "claude" }] },
      });

      const response = await handler.handleSamplingRequest(request, "trace-1", 1);

      expect(response.role).toBe("assistant");
      expect(response.content).toEqual({ type: "text", text: "Hello from Claude!" });
      expect(response.model).toBe("claude-3-opus");
      expect(response.stopReason).toBe("end_turn");
    });

    it("should fallback to first provider if hint not found", async () => {
      const fallbackProvider: IProvider = {
        id: "fallback",
        name: "Fallback Provider",
        models: [{ id: "fallback-model", name: "Fallback" }],
        chat: async function* () {
          yield { type: "text_delta", text: "Fallback response" };
          yield { type: "finish", stopReason: "end_turn" };
        },
      };
      ctx.providers = {
        list: () => [fallbackProvider],
        get: () => undefined,
      };

      const request = makeSamplingRequest({
        modelPreferences: { hints: [{ name: "nonexistent-model" }] },
      });

      const response = await handler.handleSamplingRequest(request, "trace-1", 1);

      expect(response.model).toBe("fallback-model");
      expect(response.content).toEqual({ type: "text", text: "Fallback response" });
    });

    it("should handle provider error and emit MCP_SAMPLING_ERROR", async () => {
      const errorProvider: IProvider = {
        id: "error-provider",
        name: "Error Provider",
        models: [{ id: "error-model", name: "Error" }],
        chat: async function* () {
          throw new Error("Provider failed");
        },
      };
      ctx.providers = {
        list: () => [errorProvider],
        get: () => undefined,
      };

      const request = makeSamplingRequest();

      await expect(handler.handleSamplingRequest(request, "trace-error", 1)).rejects.toThrow(
        "Provider invocation failed"
      );

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_ERROR,
          payload: expect.objectContaining({
            error: expect.stringContaining("Provider failed"),
          }),
        })
      );
    });

    it("should emit MCP_SAMPLING_RESPONSE on success", async () => {
      const mockProvider = makeMockProvider("test", ["test-model"]);
      ctx.providers = { list: () => [mockProvider], get: () => undefined };

      const request = makeSamplingRequest();
      await handler.handleSamplingRequest(request, "trace-success", 1);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SAMPLING_RESPONSE,
          payload: expect.objectContaining({
            serverName: "test-server",
            traceId: "trace-success",
            model: "test-model",
          }),
        })
      );
    });
  });
});
