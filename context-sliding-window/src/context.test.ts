/**
 * Tests for the sliding-window context manager — the DEFAULT IContextManager
 * (mounted in configs/phase6-agent.json). Was shipped with zero test coverage
 * (v0.59.7 audit); these assert the actual assembleContext windowing contract.
 */

import { describe, it, expect } from "vitest";
import type { Message } from "@openstarry/sdk";
import { createContextManager } from "./context.js";

let seq = 0;
function msg(role: Message["role"], text: string): Message {
  seq += 1;
  return { id: `m${seq}`, role, content: [{ type: "text", text }], createdAt: seq };
}

describe("context-sliding-window assembleContext", () => {
  const cm = createContextManager();

  it("returns [] for empty input", () => {
    expect(cm.assembleContext([], 5)).toEqual([]);
  });

  it("maxTurns <= 0 returns all messages (system first, then conversation)", () => {
    const messages: Message[] = [
      msg("user", "u1"),
      msg("system", "s1"),
      msg("assistant", "a1"),
    ];
    const out = cm.assembleContext(messages, 0);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("system");
    // conversation order preserved after the system block
    expect(out.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("always includes system messages even when windowing drops old turns", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "turn1"),
      msg("assistant", "resp1"),
      msg("user", "turn2"),
      msg("assistant", "resp2"),
    ];
    const out = cm.assembleContext(messages, 1);
    // system retained; only the last user turn + its response kept
    expect(out.some((m) => m.role === "system")).toBe(true);
    const texts = out.flatMap((m) => m.content).map((c) => (c as { text: string }).text);
    expect(texts).toContain("sys");
    expect(texts).toContain("turn2");
    expect(texts).toContain("resp2");
    expect(texts).not.toContain("turn1");
    expect(texts).not.toContain("resp1");
  });

  it("keeps exactly the last N user turns (with their assistant/tool messages)", () => {
    const messages: Message[] = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("tool", "t2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
      msg("assistant", "a3"),
    ];
    const out = cm.assembleContext(messages, 2);
    const texts = out.flatMap((m) => m.content).map((c) => (c as { text: string }).text);
    // last 2 user turns: u2 (+t2,a2) and u3 (+a3). u1/a1 dropped.
    expect(texts).not.toContain("u1");
    expect(texts).not.toContain("a1");
    expect(texts).toEqual(["u2", "t2", "a2", "u3", "a3"]);
  });

  it("keeps everything when fewer user turns than maxTurns", () => {
    const messages: Message[] = [msg("user", "only"), msg("assistant", "reply")];
    const out = cm.assembleContext(messages, 10);
    expect(out).toHaveLength(2);
  });

  it("preserves multiple system messages and places them before conversation", () => {
    const messages: Message[] = [
      msg("system", "s1"),
      msg("user", "u1"),
      msg("system", "s2"),
      msg("assistant", "a1"),
    ];
    const out = cm.assembleContext(messages, 5);
    expect(out.slice(0, 2).map((m) => m.role)).toEqual(["system", "system"]);
    expect(out.slice(2).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
