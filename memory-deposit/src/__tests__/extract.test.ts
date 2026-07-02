import { describe, it, expect } from "vitest";
import type { Message } from "@openstarry/sdk";
import {
  parseExtractionResponse,
  messagesToTranscript,
  buildExtractionMessages,
} from "../extract.js";

function msg(role: Message["role"], text: string, id = role): Message {
  return { id, role, content: [{ type: "text", text }], createdAt: 1 };
}

describe("parseExtractionResponse", () => {
  it("parses a clean JSON array of facts", () => {
    const out = parseExtractionResponse('[{"type":"correction","text":"Use ISO dates","importance":9}]');
    expect(out).toEqual([{ type: "correction", text: "Use ISO dates", importance: 9 }]);
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const raw = 'Here are the facts:\n```json\n[{"type":"preference","text":"Prefers dark mode","importance":6}]\n```\nDone.';
    const out = parseExtractionResponse(raw);
    expect(out).toEqual([{ type: "preference", text: "Prefers dark mode", importance: 6 }]);
  });

  it("drops unknown types and empty text, clamps importance", () => {
    const raw = JSON.stringify([
      { type: "bogus", text: "x", importance: 5 },
      { type: "convention", text: "  ", importance: 5 },
      { type: "convention", text: "Two-space indent", importance: 99 },
      { type: "correction", text: "No trailing commas", importance: 0 },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out).toEqual([
      { type: "convention", text: "Two-space indent", importance: 10 },
      { type: "correction", text: "No trailing commas", importance: 1 },
    ]);
  });

  it("defaults missing/NaN importance to 5", () => {
    const out = parseExtractionResponse('[{"type":"preference","text":"likes tea"}]');
    expect(out[0].importance).toBe(5);
  });

  it("returns [] for empty [], non-array, or garbage", () => {
    expect(parseExtractionResponse("[]")).toEqual([]);
    expect(parseExtractionResponse('{"type":"preference"}')).toEqual([]);
    expect(parseExtractionResponse("not json at all")).toEqual([]);
    expect(parseExtractionResponse("")).toEqual([]);
  });

  it("caps at maxFacts", () => {
    const raw = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ type: "preference", text: `p${i}`, importance: 5 })),
    );
    expect(parseExtractionResponse(raw, 3)).toHaveLength(3);
  });
});

describe("messagesToTranscript", () => {
  it("skips system messages and labels roles", () => {
    const t = messagesToTranscript(
      [msg("system", "PINNED core block"), msg("user", "hello"), msg("assistant", "hi")],
      10,
      2000,
    );
    expect(t).not.toContain("PINNED");
    expect(t).toContain("USER: hello");
    expect(t).toContain("ASSISTANT: hi");
  });

  it("caps bulky content", () => {
    const t = messagesToTranscript([msg("user", "x".repeat(5000))], 10, 100);
    // 100 chars + ellipsis + "USER: " prefix
    expect(t.length).toBeLessThan(200);
    expect(t).toContain("…");
  });

  it("takes only the most recent N messages", () => {
    const many = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`, `u${i}`));
    const t = messagesToTranscript(many, 2, 2000);
    expect(t).toContain("m8");
    expect(t).toContain("m9");
    expect(t).not.toContain("m0");
  });
});

describe("bilingual extraction contract (cross-language follow-up)", () => {
  it("the system prompt instructs bilingual seed text with space-separated original-language terms", async () => {
    const { EXTRACT_SYSTEM_PROMPT } = await import("../extract.js");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("another language");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("SEPARATED BY SPACES");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("縮排 2 空格");
  });
});

describe("buildExtractionMessages", () => {
  it("produces a system+user pair carrying the transcript", () => {
    const out = buildExtractionMessages("USER: use ISO dates", () => 42, (n) => `id-${n}`);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[1].role).toBe("user");
    const userText = out[1].content[0].type === "text" ? out[1].content[0].text : "";
    expect(userText).toContain("use ISO dates");
    expect(out[0].createdAt).toBe(42);
  });
});
