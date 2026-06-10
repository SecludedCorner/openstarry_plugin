/**
 * index.test.ts — Tests for provider-claude plugin.
 */

import { describe, it, expect, vi } from "vitest";
import { convertMessages } from "./message-converter.js";
import { streamClaudeMessages } from "./api.js";
import type { Message, ProviderStreamEvent } from "@openstarry/sdk";

describe("message-converter", () => {
  it("should convert user text messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: [{ type: "text", text: "Hello, Claude!" }],
        createdAt: Date.now(),
      },
    ];

    const result = convertMessages(messages);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello, Claude!" }],
    });
  });

  it("should extract system messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant." }],
        createdAt: Date.now(),
      },
      {
        id: "2",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        createdAt: Date.now(),
      },
    ];

    const result = convertMessages(messages);

    expect(result.system).toBe("You are a helpful assistant.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("should convert assistant messages with tool calls", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: {
              id: "call_123",
              name: "get_weather",
              arguments: { city: "San Francisco" },
            },
          },
        ],
        createdAt: Date.now(),
      },
    ];

    const result = convertMessages(messages);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_123",
          name: "get_weather",
          input: { city: "San Francisco" },
        },
      ],
    });
  });

  it("should convert tool result messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolResult: {
              toolCallId: "call_123",
              name: "get_weather",
              result: "Sunny, 72°F",
            },
          },
        ],
        createdAt: Date.now(),
      },
    ];

    const result = convertMessages(messages);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: "Sunny, 72°F",
        },
      ],
    });
  });

  it("should convert reasoning segments", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          { type: "text", text: "The answer is 42." },
        ],
        createdAt: Date.now(),
      },
    ];

    const result = convertMessages(messages);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "text", text: "The answer is 42." },
      ],
    });
  });

  it("should convert tools to Anthropic format", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: [{ type: "text", text: "Use tools" }],
        createdAt: Date.now(),
      },
    ];

    const tools = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ];

    const result = convertMessages(messages, undefined, tools);

    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]).toEqual({
      name: "get_weather",
      description: "Get weather for a city",
      input_schema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
    });
  });
});

describe("api streaming", () => {
  it("should parse text delta events", async () => {
    const mockResponse = new Response(
      `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const events: ProviderStreamEvent[] = [];
    for await (const event of streamClaudeMessages(
      "sk-ant-test",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        stream: true,
      },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: " world" });
    expect(events[2]).toMatchObject({
      type: "finish",
      stopReason: "end_turn",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    });
  });

  it("should parse tool call events", async () => {
    const mockResponse = new Response(
      `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4-20250514","usage":{"input_tokens":50}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}
`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const events: ProviderStreamEvent[] = [];
    for await (const event of streamClaudeMessages(
      "sk-ant-test",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "Weather?" }] }],
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: { type: "object", properties: {} },
          },
        ],
        stream: true,
      },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({
      type: "tool_call_start",
      toolCallId: "toolu_abc",
      name: "get_weather",
    });
    expect(events[1]).toEqual({
      type: "tool_call_delta",
      toolCallId: "toolu_abc",
      input: '{"city":',
    });
    expect(events[2]).toEqual({
      type: "tool_call_delta",
      toolCallId: "toolu_abc",
      input: '"SF"}',
    });
    expect(events[3]).toEqual({
      type: "tool_call_end",
      toolCallId: "toolu_abc",
      name: "get_weather",
      input: '{"city":"SF"}',
    });
    expect(events[4]).toMatchObject({
      type: "finish",
      stopReason: "tool_use",
    });
  });

  it("should parse reasoning (thinking) events", async () => {
    const mockResponse = new Response(
      `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}
`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const events: ProviderStreamEvent[] = [];
    for await (const event of streamClaudeMessages(
      "sk-ant-test",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "Think" }] }],
        stream: true,
      },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "reasoning_delta", text: "Let me think" });
    expect(events[1]).toEqual({ type: "text_delta", text: "Answer" });
    expect(events[2]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });

  it("should handle API errors", async () => {
    const mockResponse = new Response(
      JSON.stringify({ error: { message: "Invalid API key" } }),
      { status: 401 },
    );

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const events: ProviderStreamEvent[] = [];
    for await (const event of streamClaudeMessages(
      "invalid-key",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        stream: true,
      },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toContain("401");
    }
  });

  it("should handle network errors", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const events: ProviderStreamEvent[] = [];
    for await (const event of streamClaudeMessages(
      "sk-ant-test",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        stream: true,
      },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe("Network error");
    }
  });
});
