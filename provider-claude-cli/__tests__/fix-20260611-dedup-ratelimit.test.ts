/**
 * FIX-2026-06-11 repair sprint — two stream-mapping fixes:
 *
 * 1. Double-render dedup: claude CLI >=2.1.14x emits BOTH incremental
 *    stream_event text deltas AND a final full-message `assistant` line for
 *    the same turn. Previously both mapped to text_delta, so the UI rendered
 *    the response twice (observed: "PINEAPPLEPINEAPPLE" in the 2026-06-11
 *    cold-user smoke run). mapStreamEvent now accepts an optional per-stream
 *    StreamMapState; once a stream_event delta has been seen, assistant
 *    full-message lines are dropped as duplicates. Legacy CLIs that emit
 *    ONLY assistant lines are unaffected (state stays false).
 *
 * 2. rate_limit_event silencing: CLI >=2.1.170 emits `rate_limit_event` on
 *    every call (informational rate-limit telemetry). It is now in
 *    KNOWN_SILENT_TYPES, so onUnknown is no longer invoked for it.
 *    Resolves DT-42-B sub-task B (was DEFERRED pending Master decision;
 *    Master directed the fix in the 2026-06-11 repair sprint).
 */

import { describe, expect, it, vi } from "vitest";
import { mapStreamEvent, type StreamMapState } from "../src/index.js";

describe("mapStreamEvent — duplicate assistant line dedup (FIX-2026-06-11)", () => {
  it("drops the assistant full-message line after stream_event deltas were seen", () => {
    const state: StreamMapState = { sawStreamDelta: false };

    const d1 = mapStreamEvent(
      { type: "stream_event", event: { delta: { type: "text_delta", text: "PINE" } } },
      undefined,
      state,
    );
    const d2 = mapStreamEvent(
      { type: "stream_event", event: { delta: { type: "text_delta", text: "APPLE" } } },
      undefined,
      state,
    );
    expect(d1).toEqual({ type: "text_delta", text: "PINE" });
    expect(d2).toEqual({ type: "text_delta", text: "APPLE" });
    expect(state.sawStreamDelta).toBe(true);

    // The duplicate full-message assistant line must be suppressed.
    const dup = mapStreamEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "PINEAPPLE" }] },
      },
      undefined,
      state,
    );
    expect(dup).toBeNull();
  });

  it("still passes assistant lines when NO stream deltas were seen (legacy CLI)", () => {
    const state: StreamMapState = { sawStreamDelta: false };
    const evt = mapStreamEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "legacy-only" }] },
      },
      undefined,
      state,
    );
    expect(evt).toEqual({ type: "text_delta", text: "legacy-only" });
  });

  it("remains backward compatible when no state is passed (old call sites)", () => {
    const evt = mapStreamEvent({
      type: "assistant",
      content: [{ type: "text", text: "no-state" }],
    });
    expect(evt).toEqual({ type: "text_delta", text: "no-state" });
  });

  it("non-text stream deltas do NOT mark sawStreamDelta", () => {
    const state: StreamMapState = { sawStreamDelta: false };
    mapStreamEvent(
      { type: "stream_event", event: { delta: { type: "input_json_delta" } } },
      undefined,
      state,
    );
    expect(state.sawStreamDelta).toBe(false);
    // assistant line still passes — nothing was streamed.
    const evt = mapStreamEvent(
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
      undefined,
      state,
    );
    expect(evt).toEqual({ type: "text_delta", text: "ok" });
  });
});

describe("mapStreamEvent — rate_limit_event silencing (FIX-2026-06-11, DT-42-B sub-task B)", () => {
  it("does NOT invoke onUnknown for rate_limit_event lines", () => {
    const onUnknown = vi.fn();
    const evt = mapStreamEvent({ type: "rate_limit_event" }, onUnknown);
    expect(evt).toBeNull();
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it("still invokes onUnknown for genuinely novel line types", () => {
    const onUnknown = vi.fn();
    const evt = mapStreamEvent({ type: "totally_new_event" }, onUnknown);
    expect(evt).toBeNull();
    expect(onUnknown).toHaveBeenCalledWith("totally_new_event");
  });
});
