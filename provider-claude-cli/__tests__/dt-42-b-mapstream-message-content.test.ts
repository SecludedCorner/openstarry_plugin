/**
 * DT-42-B (cycle 03-43) — mapStreamEvent assistant message.content shape support.
 *
 * Per cycle 03-42 R1 §D §5 reconciliation: claude CLI v2.1.140+ emits the
 * assistant content array nested at `message.content` instead of top-level
 * `content`. Without this fix, the events fall through to `onUnknown` warn.
 *
 * Resolves FIX-cy31-A1-1-T4-MAPSTREAM sub-task A (dormant 10 cycles since
 * cycle 03-31 Stream 1 tier-4 inaugural P3 LOW finding).
 *
 * Sub-task B (rate_limit_event silencing vs structured event) is DEFERRED
 * pending Master Plan binding decision (per cycle 03-42 R1 §D §5.5).
 */

import { describe, expect, it, vi } from "vitest";
import { mapStreamEvent } from "../src/index.js";

describe("mapStreamEvent — assistant.message.content shape (v2.1.140+, DT-42-B)", () => {
  it("extracts text from line.message.content[].text (v2.1.140+ shape)", () => {
    const evt = mapStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(evt).toEqual({ type: "text_delta", text: "hello world" });
  });

  it("still extracts text from legacy line.content[].text (older CLI shape)", () => {
    const evt = mapStreamEvent({
      type: "assistant",
      content: [{ type: "text", text: "legacy" }],
    });
    expect(evt).toEqual({ type: "text_delta", text: "legacy" });
  });

  it("returns null when both shapes are absent", () => {
    expect(mapStreamEvent({ type: "assistant" })).toBeNull();
  });

  it("returns null when message.content array contains only non-text parts", () => {
    expect(
      mapStreamEvent({
        type: "assistant",
        message: {
          content: [{ type: "tool_use" } as { type?: string; text?: string }],
        },
      }),
    ).toBeNull();
  });

  it("does NOT invoke onUnknown for assistant lines with message.content shape", () => {
    const onUnknown = vi.fn();
    mapStreamEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "x" }] },
      },
      onUnknown,
    );
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it("legacy line.content takes precedence over line.message.content (no double-counting)", () => {
    // If both shapes are present (theoretical), prefer legacy to maintain
    // backward compatibility with existing call sites.
    const evt = mapStreamEvent({
      type: "assistant",
      content: [{ type: "text", text: "legacy" }],
      message: { content: [{ type: "text", text: "new" }] },
    });
    expect(evt).toEqual({ type: "text_delta", text: "legacy" });
  });
});
