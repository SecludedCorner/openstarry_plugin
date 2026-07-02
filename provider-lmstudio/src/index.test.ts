/**
 * provider-lmstudio — pure-function unit tests + stubbed-fetch integration tests.
 *
 * Hardening ticket (2026-06-12, task #21 地端硬化): the SSE parsing that
 * previously lived inline in `LmStudioProvider.chat()` is now extracted into
 * pure named exports (`parseSseLine`, `mapOpenAiChunk`, `buildPayload`,
 * `convertMessages`) so every branch is unit-testable without a live LM
 * Studio server. Wire behavior is asserted to be identical to the
 * pre-extraction code: same ProviderStreamEvent sequence for the same bytes,
 * same error messages.
 *
 * Testing idiom mirrors provider-claude-cli/__tests__/index.test.ts (named
 * exports of pure functions, direct unit tests, no framework magic).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest, Message, ProviderStreamEvent } from "@openstarry/sdk";
import {
  buildPayload,
  convertMessages,
  LmStudioProvider,
  mapOpenAiChunk,
  parseSseLine,
} from "./index.js";

// ─── helpers ───

function msg(role: Message["role"], text: string): Message {
  return { id: "m-test", role, content: [{ type: "text", text }], createdAt: 0 };
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: "test-model", messages: [msg("user", "hi")], ...overrides };
}

function makeProvider(baseUrl = "http://stub.invalid/v1"): LmStudioProvider {
  const provider = new LmStudioProvider();
  provider.configured = true;
  provider.baseUrl = baseUrl;
  return provider;
}

/** Build a ReadableStream<Uint8Array> from string parts (one enqueue per part). */
function byteStream(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── parseSseLine ───

describe("provider-lmstudio — parseSseLine", () => {
  it("parses a valid data line into a chunk", () => {
    const result = parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}');
    expect(result).toEqual({
      kind: "chunk",
      chunk: { choices: [{ delta: { content: "hi" } }] },
    });
  });

  it("classifies the [DONE] sentinel as done", () => {
    expect(parseSseLine("data: [DONE]")).toEqual({ kind: "done" });
  });

  it("trims whitespace/CR before classifying (CRLF wire format)", () => {
    expect(parseSseLine("  data: [DONE]\r")).toEqual({ kind: "done" });
    expect(parseSseLine('data: {"choices":[]}\r')).toEqual({
      kind: "chunk",
      chunk: { choices: [] },
    });
  });

  it("skips empty/whitespace-only lines", () => {
    expect(parseSseLine("")).toEqual({ kind: "skip" });
    expect(parseSseLine("   ")).toEqual({ kind: "skip" });
    expect(parseSseLine("\r")).toEqual({ kind: "skip" });
  });

  it("skips non-data SSE lines (comments, event fields)", () => {
    expect(parseSseLine(": keep-alive")).toEqual({ kind: "skip" });
    expect(parseSseLine("event: message")).toEqual({ kind: "skip" });
    expect(parseSseLine("id: 42")).toEqual({ kind: "skip" });
  });

  it('requires the "data: " prefix WITH trailing space (no-space variant skipped, as before extraction)', () => {
    expect(parseSseLine('data:{"choices":[]}')).toEqual({ kind: "skip" });
  });

  it("silently skips malformed JSON after the data prefix", () => {
    expect(parseSseLine("data: {not json")).toEqual({ kind: "skip" });
    expect(parseSseLine("data: ")).toEqual({ kind: "skip" });
  });
});

// ─── mapOpenAiChunk ───

describe("provider-lmstudio — mapOpenAiChunk", () => {
  it("maps delta.content to a single text_delta", () => {
    expect(mapOpenAiChunk({ choices: [{ delta: { content: "hello" } }] })).toEqual([
      { type: "text_delta", text: "hello" },
    ]);
  });

  it("skips empty-string content (truthiness check preserved)", () => {
    expect(mapOpenAiChunk({ choices: [{ delta: { content: "" } }] })).toEqual([]);
  });

  it("returns no events for missing or empty choices", () => {
    expect(mapOpenAiChunk({})).toEqual([]);
    expect(mapOpenAiChunk({ choices: [] })).toEqual([]);
  });

  it('finish_reason "stop" → finish with stopReason end_turn and no usage', () => {
    expect(mapOpenAiChunk({ choices: [{ delta: {}, finish_reason: "stop" }] })).toEqual([
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it('finish_reason "length" → stopReason max_tokens', () => {
    expect(mapOpenAiChunk({ choices: [{ delta: {}, finish_reason: "length" }] })).toEqual([
      { type: "finish", stopReason: "max_tokens", usage: undefined },
    ]);
  });

  it('finish_reason "tool_calls" → stopReason tool_use (L block — was mis-mapped to end_turn)', () => {
    expect(mapOpenAiChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })).toEqual([
      { type: "finish", stopReason: "tool_use", usage: undefined },
    ]);
  });

  it('other truthy finish_reason (e.g. "content_filter") → end_turn', () => {
    expect(mapOpenAiChunk({ choices: [{ delta: {}, finish_reason: "content_filter" }] })).toEqual([
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it("finish_reason null (mid-stream chunk) yields no finish", () => {
    expect(mapOpenAiChunk({ choices: [{ delta: { content: "x" }, finish_reason: null }] })).toEqual([
      { type: "text_delta", text: "x" },
    ]);
  });

  it("content + finish_reason in the same chunk yields [text_delta, finish] in order", () => {
    expect(
      mapOpenAiChunk({ choices: [{ delta: { content: "tail" }, finish_reason: "stop" }] }),
    ).toEqual([
      { type: "text_delta", text: "tail" },
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it("extracts usage from the finish chunk into TokenUsage", () => {
    expect(
      mapOpenAiChunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 },
      }),
    ).toEqual([
      {
        type: "finish",
        stopReason: "end_turn",
        usage: { promptTokens: 7, completionTokens: 13, totalTokens: 20 },
      },
    ]);
  });

  it("throws TypeError when choices[0] lacks delta (faithful extraction; generator converts to error event)", () => {
    expect(() =>
      mapOpenAiChunk({ choices: [{ finish_reason: "stop" } as unknown as { delta: { content?: string } }] }),
    ).toThrow(TypeError);
  });
});

// ─── convertMessages ───

describe("provider-lmstudio — convertMessages", () => {
  it("prepends systemPrompt as a system message", () => {
    expect(convertMessages([msg("user", "hi")], "be brief")).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("omits the system message when no systemPrompt is given", () => {
    expect(convertMessages([msg("user", "hi")])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("joins multiple text segments with newline", () => {
    const m: Message = {
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      createdAt: 0,
    };
    expect(convertMessages([m])).toEqual([{ role: "assistant", content: "line one\nline two" }]);
  });

  it("L block: tool_call segments map to an assistant tool_calls message (no longer dropped)", () => {
    const toolOnly: Message = {
      id: "m2",
      role: "assistant",
      content: [{ type: "tool_call", toolCall: { id: "t1", name: "fs.list", arguments: { path: "." } } }],
      createdAt: 0,
    };
    expect(convertMessages([toolOnly])).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "fs.list", arguments: '{"path":"."}' } },
        ],
      },
    ]);
  });

  it("L block: tool_result segments map to role:'tool' messages with tool_call_id; same-message text is kept", () => {
    const mixed: Message = {
      id: "m3",
      role: "user",
      content: [
        { type: "tool_result", toolResult: { toolCallId: "t1", name: "fs.list", result: "a.txt\nb.txt" } },
        { type: "text", text: "kept" },
      ],
      createdAt: 0,
    };
    expect(convertMessages([mixed])).toEqual([
      { role: "user", content: "kept" },
      { role: "tool", content: "a.txt\nb.txt", tool_call_id: "t1" },
    ]);
  });

  it("L block: assistant text + tool_call in one message combine into content + tool_calls", () => {
    const both: Message = {
      id: "m4",
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_call", toolCall: { id: "t2", name: "fs.read", arguments: { path: "x" } } },
      ],
      createdAt: 0,
    };
    expect(convertMessages([both])).toEqual([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          { id: "t2", type: "function", function: { name: "fs.read", arguments: '{"path":"x"}' } },
        ],
      },
    ]);
  });
});

// ─── L block: streaming tool-call assembly + payload tools ───

describe("provider-lmstudio — createOpenAiStreamMapper (tool-call assembly)", () => {
  it("assembles the LM-Studio-verified fragment sequence: start → delta(s) → end → finish tool_use", async () => {
    const { createOpenAiStreamMapper } = await import("./index.js");
    const m = createOpenAiStreamMapper();
    // fragment 1: index/id/name + empty arguments (wire-verified 2026-07-02)
    const e1 = m.mapChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "631706800", type: "function", function: { name: "fs.list", arguments: "" } }] }, finish_reason: null }],
    });
    expect(e1).toEqual([{ type: "tool_call_start", toolCallId: "631706800", name: "fs.list" }]);
    // fragment 2: index + argument piece only
    const e2 = m.mapChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: '{"path"' } }] }, finish_reason: null }],
    });
    const e3 = m.mapChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: ':"."}' } }] }, finish_reason: null }],
    });
    expect(e2).toEqual([{ type: "tool_call_delta", toolCallId: "631706800", input: '{"path"' }]);
    expect(e3).toEqual([{ type: "tool_call_delta", toolCallId: "631706800", input: ':"."}' }]);
    // finish: end carries the FULL assembled args
    const e4 = m.mapChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    expect(e4).toEqual([
      { type: "tool_call_end", toolCallId: "631706800", name: "fs.list", input: '{"path":"."}' },
      { type: "finish", stopReason: "tool_use", usage: undefined },
    ]);
  });

  it("buffers argument pieces that arrive before the name, flushing after start", async () => {
    const { createOpenAiStreamMapper } = await import("./index.js");
    const m = createOpenAiStreamMapper(() => "gen-1");
    const e1 = m.mapChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }, finish_reason: null }],
    });
    expect(e1).toEqual([]); // buffered — no start yet
    const e2 = m.mapChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "t", arguments: ":1}" } }] }, finish_reason: null }],
    });
    expect(e2).toEqual([
      { type: "tool_call_start", toolCallId: "gen-1", name: "t" }, // id synthesized
      { type: "tool_call_delta", toolCallId: "gen-1", input: '{"a"' }, // flushed buffer
      { type: "tool_call_delta", toolCallId: "gen-1", input: ":1}" },
    ]);
  });

  it("maps reasoning_content to reasoning_delta (LM Studio reasoning models)", async () => {
    const { createOpenAiStreamMapper } = await import("./index.js");
    const m = createOpenAiStreamMapper();
    expect(m.mapChunk({ choices: [{ delta: { reasoning_content: "thinking…" }, finish_reason: null }] })).toEqual([
      { type: "reasoning_delta", text: "thinking…" },
    ]);
  });
});

describe("provider-lmstudio — buildPayload tools (L block)", () => {
  it("appends OpenAI function declarations + tool_choice auto when tools are present", () => {
    const payload = buildPayload(
      makeRequest({
        tools: [{ name: "fs.list", description: "List files", parameters: { type: "object", properties: {} } }],
      }),
    );
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: { name: "fs.list", description: "List files", parameters: { type: "object", properties: {} } },
      },
    ]);
    expect(payload.tool_choice).toBe("auto");
  });

  it("tool-less payloads stay byte-identical (no tools/tool_choice keys)", () => {
    const payload = buildPayload(makeRequest());
    expect("tools" in payload).toBe(false);
    expect("tool_choice" in payload).toBe(false);
  });
});

// ─── buildPayload ───

describe("provider-lmstudio — buildPayload", () => {
  it("builds the base payload with stream:true and converted messages", () => {
    const payload = buildPayload(makeRequest({ systemPrompt: "sys" }));
    expect(payload).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    expect("max_tokens" in payload).toBe(false);
    expect("temperature" in payload).toBe(false);
  });

  it("forwards maxTokens/temperature only when defined — including 0", () => {
    const payload = buildPayload(makeRequest({ maxTokens: 128, temperature: 0 }));
    expect(payload.max_tokens).toBe(128);
    expect(payload.temperature).toBe(0);
  });

  it("emits keys in the original order (model, messages, stream, max_tokens, temperature) for byte-identical request bodies", () => {
    const payload = buildPayload(makeRequest({ maxTokens: 5, temperature: 0.2 }));
    expect(Object.keys(payload)).toEqual(["model", "messages", "stream", "max_tokens", "temperature"]);
  });
});

// ─── chat() integration (stubbed global fetch) ───

describe("provider-lmstudio — chat() integration with stubbed fetch", () => {
  it("yields a single error event (and never calls fetch) when not configured", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const provider = new LmStudioProvider(); // configured = false
    const events = await collect(provider.chat(makeRequest()));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe(
        "LM Studio not configured. Use /provider login lmstudio [BASE_URL] to connect.",
      );
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("streams text_delta events then finish — with a chunk split mid-line to prove buffer handling", async () => {
    // The first SSE line is split across two network chunks in the middle of
    // the JSON payload; the line buffer must reassemble it.
    const stream = byteStream(
      'data: {"choices":[{"delta":{"con',
      'tent":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    );
    const fetchStub = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    const abort = new AbortController();
    const request = makeRequest({ systemPrompt: "sys", signal: abort.signal });
    const events = await collect(makeProvider("http://127.0.0.1:1234/v1").chat(request));

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);

    // Request surface: URL, method, headers, body, abort signal pass-through.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.signal).toBe(abort.signal);
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
  });

  it("maps finish_reason length → stopReason max_tokens and extracts usage", async () => {
    const stream = byteStream(
      'data: {"choices":[{"delta":{"content":"truncated"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12}}\n\n',
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toEqual([
      { type: "text_delta", text: "truncated" },
      {
        type: "finish",
        stopReason: "max_tokens",
        usage: { promptTokens: 3, completionTokens: 9, totalTokens: 12 },
      },
    ]);
  });

  it("silently skips malformed JSON and non-data lines on the wire", async () => {
    const stream = byteStream(
      ": keep-alive comment\n",
      "data: {broken json\n",
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n',
      "event: noise\n",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it("yields the exact HTTP error event on 503 (does NOT throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("model not loaded", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe(
        "LM Studio API error: 503 Service Unavailable - model not loaded",
      );
    }
  });

  it('yields error "No response body" when the response has no body', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe("No response body");
    }
  });

  it("yields an error event when fetch itself rejects (server unreachable)", async () => {
    const boom = new Error("connect ECONNREFUSED 127.0.0.1:1234");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(boom)));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error).toBe(boom);
    }
  });

  it("yields buffered text then an error event when the stream errors mid-flight", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    // pull-based so the text chunk is delivered to the reader BEFORE the
    // stream errors (an eager controller.error() in start() would surface
    // the failure ahead of the buffered bytes).
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n'),
          );
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "partial" });
    expect(events[1].type).toBe("error");
    if (events[1].type === "error") {
      expect(events[1].error.message).toContain("socket reset");
    }
  });

  it("[DONE] alone does NOT synthesize a finish event (documents pre-extraction behavior)", async () => {
    const stream = byteStream(
      'data: {"choices":[{"delta":{"content":"text"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toEqual([{ type: "text_delta", text: "text" }]);
  });

  it("a final line without trailing newline stays in the buffer and is dropped (documents pre-extraction behavior)", async () => {
    const stream = byteStream(
      'data: {"choices":[{"delta":{"content":"kept"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"content":"lost"},"finish_reason":null}]}', // no \n before close
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toEqual([{ type: "text_delta", text: "kept" }]);
  });

  it("a chunk whose first choice lacks delta surfaces as an error event (TypeError caught by the generator)", async () => {
    const stream = byteStream(
      'data: {"choices":[{"delta":{"content":"before"},"finish_reason":null}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "before" });
    expect(events[1].type).toBe("error");
    if (events[1].type === "error") {
      expect(events[1].error).toBeInstanceOf(TypeError);
    }
  });

  it("stops reading the stream after finish (lines after the finish chunk are ignored)", async () => {
    const stream = byteStream(
      'data: {"choices":[{"delta":{"content":"only"},"finish_reason":"stop"}]}\n' +
        'data: {"choices":[{"delta":{"content":"after-finish"},"finish_reason":null}]}\n',
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events = await collect(makeProvider().chat(makeRequest()));
    expect(events).toEqual([
      { type: "text_delta", text: "only" },
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });
});
