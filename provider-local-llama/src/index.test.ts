/**
 * provider-local-llama — unit + integration tests.
 *
 * Unit-tests the pure NDJSON mapping exports (parseOllamaLine /
 * mapOllamaChunk / mapStopReason / convertMessages / buildOllamaPayload)
 * and integration-tests `callOllamaStream` against a stubbed global fetch
 * whose body is a ReadableStream of Uint8Array chunks — including chunks
 * split mid-line to prove buffer handling (provider-claude-cli test idiom).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRequest,
  ContentSegment,
  Message,
  ProviderStreamEvent,
} from "@openstarry/sdk";
import {
  buildOllamaPayload,
  callOllamaStream,
  convertMessages,
  createLocalLlamaPlugin,
  createOllamaStreamState,
  mapOllamaChunk,
  mapStopReason,
  parseOllamaLine,
} from "./index.js";

// ─── helpers ───

let msgSeq = 0;
function msg(role: Message["role"], content: ContentSegment[]): Message {
  return { id: `m-${++msgSeq}`, role, content, createdAt: 1718000000000 };
}

function text(t: string): ContentSegment {
  return { type: "text", text: t };
}

/** Deterministic tool-call id generator for unit tests. */
function seqIds(prefix = "tc"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

async function collect(
  gen: AsyncGenerator<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const evt of gen) events.push(evt);
  return events;
}

/** Build a ReadableStream<Uint8Array> from string chunks (one per read()). */
function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── plugin smoke (kept from the original suite) ───

describe("provider-local-llama — plugin factory smoke", () => {
  it("exports createLocalLlamaPlugin factory", () => {
    expect(typeof createLocalLlamaPlugin).toBe("function");
  });

  it("returns IPlugin with manifest", () => {
    const plugin = createLocalLlamaPlugin();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/provider-local-llama");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
    expect(plugin.manifest.skandha).toBe("samjna");
  });

  it("has factory function", () => {
    const plugin = createLocalLlamaPlugin();
    expect(typeof plugin.factory).toBe("function");
  });
});

// ─── parseOllamaLine ───

describe("parseOllamaLine", () => {
  it("parses a valid NDJSON line", () => {
    const chunk = parseOllamaLine('{"message":{"role":"assistant","content":"hi"},"done":false}');
    expect(chunk).toEqual({ message: { role: "assistant", content: "hi" }, done: false });
  });

  it("trims surrounding whitespace before parsing", () => {
    const chunk = parseOllamaLine('  {"done":true}\r');
    expect(chunk).toEqual({ done: true });
  });

  it("returns null for blank lines", () => {
    expect(parseOllamaLine("")).toBeNull();
    expect(parseOllamaLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON (silently skipped — legacy behaviour)", () => {
    expect(parseOllamaLine("{not json")).toBeNull();
    expect(parseOllamaLine("garbage")).toBeNull();
  });
});

// ─── mapStopReason ───

describe("mapStopReason", () => {
  it("maps tool presence → tool_use", () => {
    expect(mapStopReason(true)).toBe("tool_use");
  });

  it("maps no tools → end_turn", () => {
    expect(mapStopReason(false)).toBe("end_turn");
  });
});

// ─── mapOllamaChunk ───

describe("mapOllamaChunk", () => {
  it("maps message.content → one text_delta", () => {
    const events = mapOllamaChunk(
      { message: { role: "assistant", content: "Hello" }, done: false },
      createOllamaStreamState(),
    );
    expect(events).toEqual([{ type: "text_delta", text: "Hello" }]);
  });

  it("emits nothing for empty content + done:false (keep-alive chunk)", () => {
    const events = mapOllamaChunk(
      { message: { role: "assistant", content: "" }, done: false },
      createOllamaStreamState(),
    );
    expect(events).toEqual([]);
  });

  it("maps one tool_call → start/delta/end triplet sharing one id, input = JSON args", () => {
    const events = mapOllamaChunk(
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Taipei" } } }],
        },
        done: false,
      },
      createOllamaStreamState(),
      seqIds(),
    );
    expect(events).toEqual([
      { type: "tool_call_start", toolCallId: "tc-1", name: "get_weather" },
      { type: "tool_call_delta", toolCallId: "tc-1", input: '{"city":"Taipei"}' },
      { type: "tool_call_end", toolCallId: "tc-1", name: "get_weather", input: '{"city":"Taipei"}' },
    ]);
  });

  it("maps two tool_calls in one chunk → two triplets with distinct ids, in order", () => {
    const events = mapOllamaChunk(
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "a", arguments: {} } },
            { function: { name: "b", arguments: { x: 1 } } },
          ],
        },
        done: false,
      },
      createOllamaStreamState(),
      seqIds(),
    );
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end",
      "tool_call_start", "tool_call_delta", "tool_call_end",
    ]);
    expect(events[0]).toMatchObject({ toolCallId: "tc-1", name: "a" });
    expect(events[3]).toMatchObject({ toolCallId: "tc-2", name: "b" });
    expect(events[4]).toMatchObject({ toolCallId: "tc-2", input: '{"x":1}' });
  });

  it("default id generator produces 16-char hex ids shared across the triplet", () => {
    const events = mapOllamaChunk(
      {
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
        done: false,
      },
      createOllamaStreamState(),
    );
    const ids = events.map((e) => (e as { toolCallId: string }).toolCallId);
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(1);
  });

  it("done:true (no tools seen) → finish stopReason=end_turn", () => {
    const events = mapOllamaChunk({ done: true }, createOllamaStreamState());
    expect(events).toEqual([{ type: "finish", stopReason: "end_turn", usage: undefined }]);
  });

  it("done:true after a tool_calls chunk in the same stream → finish stopReason=tool_use", () => {
    const state = createOllamaStreamState();
    mapOllamaChunk(
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] }, done: false },
      state,
      seqIds(),
    );
    const events = mapOllamaChunk({ done: true }, state);
    expect(events).toEqual([{ type: "finish", stopReason: "tool_use", usage: undefined }]);
  });

  it("maps prompt_eval_count/eval_count → usage on the finish event", () => {
    const events = mapOllamaChunk(
      { done: true, eval_count: 42, prompt_eval_count: 7 },
      createOllamaStreamState(),
    );
    expect(events).toEqual([
      { type: "finish", stopReason: "end_turn", usage: { promptTokens: 7, completionTokens: 42 } },
    ]);
  });

  it("missing prompt_eval_count defaults promptTokens to 0", () => {
    const [finish] = mapOllamaChunk({ done: true, eval_count: 5 }, createOllamaStreamState());
    expect(finish).toEqual({
      type: "finish", stopReason: "end_turn", usage: { promptTokens: 0, completionTokens: 5 },
    });
  });

  it("eval_count absent or 0 → usage undefined (legacy truthiness preserved)", () => {
    const [noEval] = mapOllamaChunk({ done: true, prompt_eval_count: 9 }, createOllamaStreamState());
    expect(noEval.type).toBe("finish");
    if (noEval.type === "finish") expect(noEval.usage).toBeUndefined();
    const [zeroEval] = mapOllamaChunk({ done: true, eval_count: 0, prompt_eval_count: 9 }, createOllamaStreamState());
    if (zeroEval.type === "finish") expect(zeroEval.usage).toBeUndefined();
  });

  it("finish dedup: second done chunk through the same state emits nothing", () => {
    const state = createOllamaStreamState();
    const first = mapOllamaChunk({ done: true }, state);
    expect(first).toHaveLength(1);
    const second = mapOllamaChunk({ done: true, eval_count: 3 }, state);
    expect(second).toEqual([]);
  });

  it("done chunk that also carries trailing content yields text_delta BEFORE finish", () => {
    const events = mapOllamaChunk(
      { message: { role: "assistant", content: "bye" }, done: true },
      createOllamaStreamState(),
    );
    expect(events.map((e) => e.type)).toEqual(["text_delta", "finish"]);
  });
});

// ─── convertMessages ───

describe("convertMessages", () => {
  it("prepends systemPrompt as a system message", () => {
    const out = convertMessages([msg("user", [text("hi")])], "be terse");
    expect(out).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });

  it("a system message OVERRIDES the systemPrompt parameter (last wins)", () => {
    const out = convertMessages(
      [msg("system", [text("from message")]), msg("user", [text("hi")])],
      "from param",
    );
    expect(out[0]).toEqual({ role: "system", content: "from message" });
    expect(out).toHaveLength(2);
  });

  it("joins multiple text segments with newline; drops empty-text messages", () => {
    const out = convertMessages([
      msg("user", [text("a"), text("b")]),
      msg("assistant", []),
    ]);
    expect(out).toEqual([{ role: "user", content: "a\nb" }]);
  });

  it("maps assistant tool_call segments → Ollama tool_calls (kept even with empty text)", () => {
    const out = convertMessages([
      msg("assistant", [
        { type: "tool_call", toolCall: { id: "x1", name: "lookup", arguments: { q: "k" } } },
      ]),
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "lookup", arguments: { q: "k" } } }],
      },
    ]);
  });

  it("maps tool messages by joining tool_result payloads", () => {
    const out = convertMessages([
      msg("tool", [
        { type: "tool_result", toolResult: { toolCallId: "x1", name: "lookup", result: "r1" } },
        { type: "tool_result", toolResult: { toolCallId: "x2", name: "lookup", result: "r2" } },
      ]),
    ]);
    expect(out).toEqual([{ role: "tool", content: "r1\nr2" }]);
  });
});

// ─── buildOllamaPayload ───

describe("buildOllamaPayload", () => {
  const baseRequest: ChatRequest = {
    model: "llama3.2",
    messages: [msg("user", [text("ping")])],
    temperature: 0.4,
  };

  it("builds model + stream:true + converted messages + temperature", () => {
    const payload = buildOllamaPayload(baseRequest);
    expect(payload.model).toBe("llama3.2");
    expect(payload.stream).toBe(true);
    expect(payload.options).toEqual({ temperature: 0.4 });
    expect(payload.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(payload.tools).toBeUndefined();
  });

  it("maps request.tools → Ollama function tools", () => {
    const payload = buildOllamaPayload({
      ...baseRequest,
      tools: [{ name: "sum", description: "adds", parameters: { type: "object" } }],
    });
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "sum", description: "adds", parameters: { type: "object" } } },
    ]);
  });

  it("empty tool list stays undefined (no tools key on the wire)", () => {
    const payload = buildOllamaPayload({ ...baseRequest, tools: [] });
    expect(payload.tools).toBeUndefined();
  });
});

// ─── callOllamaStream integration (stubbed global fetch) ───

describe("callOllamaStream — stubbed fetch integration", () => {
  const HOST = "http://fake-ollama:11434";
  const REQ = buildOllamaPayload({
    model: "llama3.2",
    messages: [msg("user", [text("hi")])],
  });

  it("POSTs JSON to {host}/api/chat", async () => {
    const fetchMock = stubFetch(new Response(byteStream(['{"done":true}\n']), { status: 200 }));
    await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HOST}/api/chat`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string).model).toBe("llama3.2");
  });

  it("reassembles NDJSON lines split mid-line across read chunks (buffer handling)", async () => {
    stubFetch(new Response(byteStream([
      '{"message":{"role":"assistant","content":"Hel',          // line 1, first half
      'lo"},"done":false}\n{"message":{"role":"assistant","con', // line 1 rest + line 2 start
      'tent":" world"},"done":false}\n',                         // line 2 rest
      '{"message":{"role":"assistant","content":""},"done":true,"eval_count":5,"prompt_eval_count":7}\n',
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "finish", stopReason: "end_turn", usage: { promptTokens: 7, completionTokens: 5 } },
    ]);
  });

  it("streams a tool-call turn end-to-end in order: text → triplet → finish tool_use", async () => {
    stubFetch(new Response(byteStream([
      '{"message":{"role":"assistant","content":"Checking."},"done":false}\n',
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Taipei"}}}]},"done":false}\n',
      '{"message":{"role":"assistant","content":""},"done":true,"eval_count":12,"prompt_eval_count":34}\n',
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events.map((e) => e.type)).toEqual([
      "text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "finish",
    ]);
    const [, start, delta, end, finish] = events;
    if (start.type !== "tool_call_start" || delta.type !== "tool_call_delta" || end.type !== "tool_call_end") {
      throw new Error("unexpected event types");
    }
    expect(start.toolCallId).toMatch(/^[0-9a-f]{16}$/);
    expect(delta.toolCallId).toBe(start.toolCallId);
    expect(end.toolCallId).toBe(start.toolCallId);
    expect(end.name).toBe("get_weather");
    expect(end.input).toBe('{"city":"Taipei"}');
    if (finish.type === "finish") {
      expect(finish.stopReason).toBe("tool_use");
      expect(finish.usage).toEqual({ promptTokens: 34, completionTokens: 12 });
    }
  });

  it("skips malformed NDJSON lines and keeps streaming (silent-skip preserved)", async () => {
    stubFetch(new Response(byteStream([
      '{"message":{"role":"assistant","content":"ok"},"done":false}\n',
      'THIS IS NOT JSON\n',
      '{"done":true}\n',
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "finish", stopReason: "end_turn", usage: undefined },
    ]);
  });

  it("emits exactly ONE finish even when the wire carries multiple done lines (dedup guard)", async () => {
    stubFetch(new Response(byteStream([
      '{"done":true,"eval_count":1}\n{"done":true,"eval_count":2}\n',
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    expect(events).toEqual([
      { type: "finish", stopReason: "end_turn", usage: { promptTokens: 0, completionTokens: 1 } },
    ]);
  });

  it("flushes a final done line WITHOUT trailing newline via the same mapper path", async () => {
    stubFetch(new Response(byteStream([
      '{"message":{"role":"assistant","content":"tail"},"done":false}\n',
      '{"done":true,"eval_count":3,"prompt_eval_count":4}', // no trailing \n → remnant path
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toEqual([
      { type: "text_delta", text: "tail" },
      { type: "finish", stopReason: "end_turn", usage: { promptTokens: 4, completionTokens: 3 } },
    ]);
  });

  it("synthesizes a defensive finish when the stream ends without any done chunk", async () => {
    stubFetch(new Response(byteStream([
      '{"message":{"role":"assistant","content":"partial"},"done":false}\n',
    ]), { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "finish", stopReason: "end_turn" },
    ]);
  });

  it("HTTP !ok → single error event 'Ollama API error: <status> <body>'", async () => {
    stubFetch(new Response("model not found", { status: 500 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe("Ollama API error: 500 model not found");
    }
  });

  it("missing response body → single error event 'No response body'", async () => {
    stubFetch(new Response(null, { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe("No response body");
    }
  });

  it("mid-stream read failure → error event with the underlying Error", async () => {
    const encoder = new TextEncoder();
    let pulled = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(encoder.encode('{"message":{"role":"assistant","content":"x"},"done":false}\n'));
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    });
    stubFetch(new Response(failing, { status: 200 }));
    const events = await collect(callOllamaStream(HOST, "llama3.2", REQ));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
    if (events[1].type === "error") {
      expect(events[1].error.message).toBe("socket reset");
    }
  });
});
