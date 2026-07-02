import { describe, it, expect, vi } from "vitest";
import type { ISeed, Message } from "@openstarry/sdk";
import { factToSeed, runDeposit } from "../deposit.js";
import type { ExtractedFact } from "../extract.js";

function userMsg(text: string, id: string): Message {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: 1 };
}

describe("factToSeed", () => {
  it("tags samskara, private, with type/text/importance in content", () => {
    const seed = factToSeed(
      { type: "correction", text: "Use ISO dates", importance: 9 },
      "agent-x",
      () => 100,
      () => "seed-1",
    );
    expect(seed).toEqual({
      seedId: "seed-1",
      agentId: "agent-x",
      skandha: "samskara",
      content: { type: "correction", text: "Use ISO dates", importance: 9 },
      visibility: "private",
      createdAt: 100,
      updatedAt: 100,
    });
  });
});

describe("runDeposit", () => {
  const facts: ExtractedFact[] = [
    { type: "correction", text: "Use ISO dates", importance: 9 },
    { type: "preference", text: "Prefers dark mode", importance: 6 },
  ];

  it("mines, plants, and returns each seed; fires onPlanted", async () => {
    const planted: ISeed[] = [];
    const onPlanted = vi.fn();
    let seq = 0;
    const out = await runDeposit({
      newMessages: [userMsg("always use ISO dates and dark mode", "u1")],
      extract: async () => facts,
      plant: async (s) => { planted.push(s); },
      agentId: "agent-x",
      maxContentChars: 2000,
      recentTurns: 8,
      now: () => 100,
      genId: () => `seed-${++seq}`,
      onPlanted,
    });
    expect(out).toHaveLength(2);
    expect(planted).toHaveLength(2);
    expect(planted[0].content).toEqual({ type: "correction", text: "Use ISO dates", importance: 9 });
    expect(planted.every((s) => s.skandha === "samskara")).toBe(true);
    expect(onPlanted).toHaveBeenCalledTimes(2);
  });

  it("plants nothing when the transcript is empty", async () => {
    const extract = vi.fn(async () => facts);
    const out = await runDeposit({
      newMessages: [],
      extract,
      plant: async () => {},
      agentId: "agent-x",
      maxContentChars: 2000,
      recentTurns: 8,
    });
    expect(out).toEqual([]);
    expect(extract).not.toHaveBeenCalled(); // no transcript → no LLM call
  });

  it("plants nothing when extraction finds no durable facts", async () => {
    const out = await runDeposit({
      newMessages: [userMsg("what's the weather", "u1")],
      extract: async () => [],
      plant: async () => { throw new Error("should not plant"); },
      agentId: "agent-x",
      maxContentChars: 2000,
      recentTurns: 8,
    });
    expect(out).toEqual([]);
  });
});
