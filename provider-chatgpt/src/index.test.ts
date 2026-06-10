import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Message } from "@openstarry/sdk";
import { convertMessages, convertTools } from "./message-converter.js";
import { streamChatCompletions } from "./api.js";

describe("message-converter", () => {
  describe("convertMessages", () => {
    it("should convert system prompt to system message", () => {
      const result = convertMessages([], "You are a helpful assistant");
      expect(result).toEqual([
        { role: "system", content: "You are a helpful assistant" },
      ]);
    });

    it("should convert user text message", () => {
      const messages: Message[] = [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: Date.now(),
        },
      ];

      const result = convertMessages(messages);
      expect(result).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("should convert assistant text message", () => {
      const messages: Message[] = [
        {
          id: randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
          createdAt: Date.now(),
        },
      ];

      const result = convertMessages(messages);
      expect(result).toEqual([{ role: "assistant", content: "Hi there!" }]);
    });

    it("should convert assistant message with tool calls", () => {
      const messages: Message[] = [
        {
          id: randomUUID(),
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCall: {
                id: "call_123",
                name: "get_weather",
                arguments: { location: "Tokyo" },
              },
            },
          ],
          createdAt: Date.now(),
        },
      ];

      const result = convertMessages(messages);
      expect(result).toEqual([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Tokyo"}',
              },
            },
          ],
        },
      ]);
    });

    it("should convert tool result message", () => {
      const messages: Message[] = [
        {
          id: randomUUID(),
          role: "user",
          content: [
            {
              type: "tool_result",
              toolResult: {
                toolCallId: "call_123",
                name: "get_weather",
                result: "Temperature: 20°C",
              },
            },
          ],
          createdAt: Date.now(),
        },
      ];

      const result = convertMessages(messages);
      expect(result).toEqual([
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "Temperature: 20°C",
        },
      ]);
    });

    it("should handle multiple messages", () => {
      const messages: Message[] = [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: "What's the weather?" }],
          createdAt: Date.now(),
        },
        {
          id: randomUUID(),
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCall: {
                id: "call_123",
                name: "get_weather",
                arguments: { location: "default" },
              },
            },
          ],
          createdAt: Date.now(),
        },
        {
          id: randomUUID(),
          role: "user",
          content: [
            {
              type: "tool_result",
              toolResult: {
                toolCallId: "call_123",
                name: "get_weather",
                result: "Sunny, 25°C",
              },
            },
          ],
          createdAt: Date.now(),
        },
        {
          id: randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: "It's sunny and 25°C!" }],
          createdAt: Date.now(),
        },
      ];

      const result = convertMessages(messages);
      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
      expect(result[1].tool_calls).toBeDefined();
      expect(result[2].role).toBe("tool");
      expect(result[3].role).toBe("assistant");
    });
  });

  describe("convertTools", () => {
    it("should convert tool schemas to OpenAI format", () => {
      const tools = [
        {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      ];

      const result = convertTools(tools);
      expect(result).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ]);
    });
  });
});

describe("api", () => {
  describe("streamChatCompletions", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("should stream text content", async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
              )
            );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200 }
      );

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const events = [];
      for await (const event of streamChatCompletions(
        "test-key",
        "https://api.openai.com/v1",
        "gpt-4o",
        []
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
      expect(events[1]).toEqual({ type: "text_delta", text: " world" });
      expect(events[2]).toEqual({
        type: "finish",
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
    });

    it("should stream tool calls", async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\""}}]}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Tokyo\\"}"}}]}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
              )
            );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200 }
      );

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const events = [];
      for await (const event of streamChatCompletions(
        "test-key",
        "https://api.openai.com/v1",
        "gpt-4o",
        []
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(5);
      expect(events[0]).toEqual({
        type: "tool_call_start",
        toolCallId: "call_123",
        name: "get_weather",
      });
      expect(events[1]).toEqual({
        type: "tool_call_delta",
        toolCallId: "call_123",
        input: '{"location"',
      });
      expect(events[2]).toEqual({
        type: "tool_call_delta",
        toolCallId: "call_123",
        input: ':"Tokyo"}',
      });
      expect(events[3]).toEqual({
        type: "tool_call_end",
        toolCallId: "call_123",
        name: "get_weather",
        input: '{"location":"Tokyo"}',
      });
      expect(events[4]).toEqual({
        type: "finish",
        stopReason: "tool_use",
        usage: undefined,
      });
    });

    it("should handle API errors", async () => {
      const mockResponse = new Response("Invalid API key", { status: 401 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const events = [];
      for await (const event of streamChatCompletions(
        "bad-key",
        "https://api.openai.com/v1",
        "gpt-4o",
        []
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect((events[0] as any).error.message).toContain("401");
    });

    it("should handle network errors", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const events = [];
      for await (const event of streamChatCompletions(
        "test-key",
        "https://api.openai.com/v1",
        "gpt-4o",
        []
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect((events[0] as any).error.message).toBe("Network error");
    });

    it("should handle custom base URL", async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200 }
      );

      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      global.fetch = mockFetch;

      const events = [];
      for await (const event of streamChatCompletions(
        "test-key",
        "https://custom.openai.azure.com/v1",
        "gpt-4o",
        []
      )) {
        events.push(event);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.openai.azure.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        })
      );

      expect(events[0]).toEqual({ type: "text_delta", text: "Hi" });
    });

    it("should respect max_tokens option", async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"length"}]}\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200 }
      );

      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      global.fetch = mockFetch;

      const events = [];
      for await (const event of streamChatCompletions(
        "test-key",
        "https://api.openai.com/v1",
        "gpt-4o",
        [],
        { maxTokens: 100 }
      )) {
        events.push(event);
      }

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.max_tokens).toBe(100);

      expect(events[events.length - 1]).toMatchObject({
        type: "finish",
        stopReason: "max_tokens",
      });
    });
  });
});
