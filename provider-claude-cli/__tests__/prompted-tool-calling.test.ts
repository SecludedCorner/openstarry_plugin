/**
 * provider-claude-cli — prompted tool-calling streaming round-trip tests.
 *
 * Protects the load-bearing daily mechanism: a text-only `claude` subprocess is
 * made tool-capable by parsing a {"tool_call":{name,arguments}} directive out of
 * its reply and re-emitting the native tool_call_start → tool_call_delta →
 * tool_call_end → finish sequence that OpenStarry's agent loop consumes, so the
 * agent runs ITS OWN tools on a text-only provider.
 *
 * The tool_call_delta is the critical event: the loop reads its input buffer
 * (filled by deltas), NOT end.input. If the delta is dropped, every argument is
 * silently lost — and before this test the ONLY coverage was the pure
 * parseToolCall; the emit sequence had zero automated tests. These inject a
 * fake stream (no live CLI) and assert the full sequence + that the delta
 * carries the args.
 */

import { describe, expect, it } from "vitest";
import type { ProviderStreamEvent } from "@openstarry/sdk";
import { emitPromptedToolCall } from "../src/index.js";

/** Build a fake subprocess stream from a list of events. */
async function* fakeStream(
  ...events: ProviderStreamEvent[]
): AsyncGenerator<ProviderStreamEvent> {
  for (const ev of events) yield ev;
}

/** Collect an async stream into an array. */
async function collect(
  gen: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Split a string into ~n text_delta chunks to simulate token streaming. */
function chunks(s: string, n = 3): ProviderStreamEvent[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: ProviderStreamEvent[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push({ type: "text_delta", text: s.slice(i, i + size) });
  }
  return out;
}

type Delta = Extract<ProviderStreamEvent, { type: "tool_call_delta" }>;
type Start = Extract<ProviderStreamEvent, { type: "tool_call_start" }>;
type End = Extract<ProviderStreamEvent, { type: "tool_call_end" }>;
type Finish = Extract<ProviderStreamEvent, { type: "finish" }>;

describe("emitPromptedToolCall — tool-call round-trip", () => {
  it("emits start → delta → end → finish(tool_use) with the delta carrying the full args", async () => {
    const directive = JSON.stringify({
      tool_call: { name: "fs.read", arguments: { path: "/etc/hosts", limit: 5 } },
    });
    const events = await collect(
      emitPromptedToolCall(
        fakeStream(
          { type: "text_delta", text: directive },
          // the subprocess emits its own finish — emitPromptedToolCall must swallow it
          { type: "finish", stopReason: "end_turn" },
        ),
      ),
    );

    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "finish",
    ]);

    const start = events[0] as Start;
    const delta = events[1] as Delta;
    const end = events[2] as End;
    const finish = events[3] as Finish;

    expect(start.name).toBe("fs.read");
    // ── The load-bearing assertion: the delta MUST carry the full args. ──
    // The loop fills its input buffer from deltas; dropping this loses all args.
    expect(delta.input).toBeTruthy();
    expect(JSON.parse(delta.input)).toEqual({ path: "/etc/hosts", limit: 5 });
    // start/delta/end share one non-empty toolCallId.
    expect(start.toolCallId).toBeTruthy();
    expect(delta.toolCallId).toBe(start.toolCallId);
    expect(end.toolCallId).toBe(start.toolCallId);
    // end mirrors the delta input and the start name.
    expect(end.input).toBe(delta.input);
    expect(end.name).toBe("fs.read");
    expect(finish.stopReason).toBe("tool_use");
  });

  it("reassembles a tool-call directive split across multiple stream chunks", async () => {
    const directive = JSON.stringify({
      tool_call: { name: "code.search", arguments: { pattern: "TODO", glob: "**/*.ts" } },
    });
    const events = await collect(
      emitPromptedToolCall(fakeStream(...chunks(directive, 5))),
    );
    const delta = events.find((e) => e.type === "tool_call_delta") as Delta | undefined;
    expect(delta).toBeDefined();
    expect(JSON.parse(delta!.input)).toEqual({ pattern: "TODO", glob: "**/*.ts" });
    expect(events.at(-1)).toMatchObject({ type: "finish", stopReason: "tool_use" });
  });

  it("tolerates a tool-call directive wrapped in prose and code fences", async () => {
    const directive =
      "Sure, I'll read it.\n```json\n" +
      JSON.stringify({ tool_call: { name: "fs.read", arguments: { path: "a.txt" } } }) +
      "\n```\n";
    const events = await collect(
      emitPromptedToolCall(fakeStream({ type: "text_delta", text: directive })),
    );
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "finish",
    ]);
    expect(JSON.parse((events[1] as Delta).input)).toEqual({ path: "a.txt" });
  });
});

describe("emitPromptedToolCall — plain text (no tool call)", () => {
  it("passes buffered text through then finish(end_turn), with NO tool_call_* events", async () => {
    const events = await collect(
      emitPromptedToolCall(
        fakeStream(
          { type: "text_delta", text: "The answer " },
          { type: "text_delta", text: "is 42." },
          { type: "finish", stopReason: "end_turn" }, // swallowed; we emit our own
        ),
      ),
    );
    expect(events).toEqual([
      { type: "text_delta", text: "The answer is 42." },
      { type: "finish", stopReason: "end_turn" },
    ]);
    expect(events.some((e) => e.type.startsWith("tool_call"))).toBe(false);
  });

  it("emits only finish(end_turn) for an empty stream (no spurious empty text_delta)", async () => {
    const events = await collect(
      emitPromptedToolCall(fakeStream({ type: "finish", stopReason: "end_turn" })),
    );
    expect(events).toEqual([{ type: "finish", stopReason: "end_turn" }]);
  });
});

describe("emitPromptedToolCall — error passthrough", () => {
  it("yields the error and stops immediately (no finish, no later events processed)", async () => {
    const err = new Error("subprocess died");
    const events = await collect(
      emitPromptedToolCall(
        fakeStream(
          { type: "text_delta", text: "partial" },
          { type: "error", error: err },
          // must never be reached: a tool-call directive after the error
          {
            type: "text_delta",
            text: JSON.stringify({ tool_call: { name: "x", arguments: {} } }),
          },
        ),
      ),
    );
    expect(events).toEqual([{ type: "error", error: err }]);
  });
});
