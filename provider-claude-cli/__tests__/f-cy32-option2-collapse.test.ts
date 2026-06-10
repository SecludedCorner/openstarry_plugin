/**
 * F-CY32 Option 2 wire-effect tests — collapseToPrompt with persona via
 * messages[0] system role (cycle 03-33 fix per Batch 27 Item #13).
 *
 * Verifies the wire-level effect of Option 2 inside provider-claude-cli:
 *   - A `role: "system"` Message at messages[0] is emitted as the LEADING
 *     `System: <persona>` transcript line at the prompt-body head.
 *   - The `--system-prompt ISOLATION_SYSTEM_PROMPT` CLI flag (set by
 *     buildArgv) is unchanged and unaffected by this code path — these
 *     tests cover only the prompt-body collapse function, not argv.
 *   - When chatRequest.systemPrompt is undefined (Option 2 default), the
 *     persona path produces a single `System:` transcript line (not two
 *     competing lines as in the pre-Option-2 wire shape).
 *
 * @see openstarry/packages/core/src/execution/guide-adapter.ts
 * @see openstarry/packages/core/src/execution/__tests__/guide-adapter.test.ts
 */

import { describe, it, expect } from "vitest";
import type { Message } from "@openstarry/sdk";
import { collapseToPrompt } from "../src/index.js";

function systemMsg(text: string, id = "s1"): Message {
  return {
    id,
    role: "system",
    content: [{ type: "text", text }],
    createdAt: 1000,
  };
}

function userMsg(text: string, id = "u1"): Message {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: 2000,
  };
}

function assistantMsg(text: string, id = "a1"): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: 3000,
  };
}

describe("collapseToPrompt — F-CY32 Option 2 persona via messages[0]", () => {
  it("emits leading 'System: <persona>' transcript line when persona is messages[0]", () => {
    const messages: Message[] = [
      systemMsg("You are SIGMA-7."),
      userMsg("Hello"),
    ];
    const prompt = collapseToPrompt(messages, undefined);

    expect(prompt.startsWith("System: You are SIGMA-7.")).toBe(true);
    expect(prompt).toContain("\n\nUser: Hello");
    expect(prompt.endsWith("Assistant:")).toBe(true);
  });

  it("Option 2 default: no duplicate 'System:' line when systemPrompt is undefined", () => {
    const messages: Message[] = [
      systemMsg("You are SIGMA-7."),
      userMsg("Hi"),
    ];
    const prompt = collapseToPrompt(messages, undefined);

    const systemLineCount = prompt
      .split("\n\n")
      .filter((line) => line.startsWith("System:"))
      .length;
    expect(systemLineCount).toBe(1);
  });

  it("preserves transcript order: system → user → assistant", () => {
    const messages: Message[] = [
      systemMsg("PERSONA"),
      userMsg("u1"),
      assistantMsg("a1"),
      userMsg("u2", "u2"),
    ];
    const prompt = collapseToPrompt(messages, undefined);
    const lines = prompt.split("\n\n");

    expect(lines[0]).toBe("System: PERSONA");
    expect(lines[1]).toBe("User: u1");
    expect(lines[2]).toBe("Assistant: a1");
    expect(lines[3]).toBe("User: u2");
    expect(lines[4]).toBe("Assistant:");
  });

  it("backwards-compat: legacy systemPrompt parameter still works when Option 2 not yet wired", () => {
    const messages: Message[] = [userMsg("Hello")];
    const prompt = collapseToPrompt(messages, "LEGACY_PERSONA");

    expect(prompt.startsWith("System: LEGACY_PERSONA")).toBe(true);
    expect(prompt).toContain("User: Hello");
  });

  it("messages[0] system + legacy systemPrompt parameter together → both emitted (no silent drop)", () => {
    // Defensive behaviour: until callers fully migrate off systemPrompt
    // parameter, both channels remain visible in the transcript. Callers
    // running Option 2 (loop.ts) pass undefined for systemPrompt, so this
    // duplicated case does not occur in production.
    const messages: Message[] = [systemMsg("FROM_MSG"), userMsg("hi")];
    const prompt = collapseToPrompt(messages, "FROM_PARAM");

    expect(prompt).toContain("System: FROM_PARAM");
    expect(prompt).toContain("System: FROM_MSG");
  });
});
