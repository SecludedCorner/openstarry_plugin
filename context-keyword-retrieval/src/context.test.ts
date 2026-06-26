import { describe, it, expect } from "vitest";
import type { Message } from "@openstarry/sdk";
import {
  createKeywordRetrievalContextManager,
} from "./context.js";
import { createKeywordRetrievalContextPlugin } from "./index.js";

let seq = 0;
function txt(role: Message["role"], text: string): Message {
  seq += 1;
  return { id: `m${seq}`, role, content: [{ type: "text", text }], createdAt: seq };
}
function ids(ms: Message[]): string[] {
  return ms.map((m) => m.id);
}

describe("KeywordRetrievalContextManager", () => {
  it("returns [] for empty input", () => {
    const cm = createKeywordRetrievalContextManager();
    expect(cm.assembleContext([], 3)).toEqual([]);
  });

  it("keeps all when maxTurns <= 0", () => {
    const cm = createKeywordRetrievalContextManager();
    const msgs = [txt("system", "sys"), txt("user", "hi"), txt("assistant", "hello")];
    expect(cm.assembleContext(msgs, 0)).toHaveLength(3);
  });

  it("always retains system messages", () => {
    const cm = createKeywordRetrievalContextManager({ topK: 1 });
    const sys = txt("system", "you are helpful");
    const msgs = [
      sys,
      txt("user", "apple orchard pruning"), txt("assistant", "prune in winter"),
      txt("user", "weather forecast"), txt("assistant", "sunny"),
      txt("user", "tell me more about apple trees"), txt("assistant", "ok"),
    ];
    const out = cm.assembleContext(msgs, 1);
    expect(ids(out)).toContain(sys.id);
  });

  it("keeps the recent window (last maxTurns user turns)", () => {
    const cm = createKeywordRetrievalContextManager({ topK: 0 || 3 });
    const u1 = txt("user", "first"); const a1 = txt("assistant", "r1");
    const u2 = txt("user", "second"); const a2 = txt("assistant", "r2");
    const out = cm.assembleContext([u1, a1, u2, a2], 1);
    // recent window = last 1 user turn = u2,a2 (u1/a1 are older, only 1 older turn <= topK so kept too here)
    expect(ids(out)).toContain(u2.id);
    expect(ids(out)).toContain(a2.id);
  });

  it("splices back the relevant older turn and drops irrelevant ones (topK=1)", () => {
    const cm = createKeywordRetrievalContextManager({ topK: 1 });
    const uApple = txt("user", "how do I grow apple trees"); const aApple = txt("assistant", "plant apple saplings in spring");
    const uWeather = txt("user", "what is the weather"); const aWeather = txt("assistant", "it is sunny");
    const uStock = txt("user", "stock market today"); const aStock = txt("assistant", "markets are up");
    const uRecent = txt("user", "more about apple orchards please"); const aRecent = txt("assistant", "orchards need spacing");

    const msgs = [uApple, aApple, uWeather, aWeather, uStock, aStock, uRecent, aRecent];
    const out = cm.assembleContext(msgs, 1); // recent = uRecent turn; older = 3 turns; topK=1
    const outIds = ids(out);

    // recent window always present
    expect(outIds).toContain(uRecent.id);
    // relevant older turn (apple) spliced back
    expect(outIds).toContain(uApple.id);
    expect(outIds).toContain(aApple.id);
    // irrelevant older turns dropped
    expect(outIds).not.toContain(uWeather.id);
    expect(outIds).not.toContain(uStock.id);
  });

  it("preserves tool_call/tool_result pairing within a selected turn", () => {
    seq = 0;
    const sys = txt("system", "sys");
    // older relevant turn with a tool_call + tool_result pair
    const uTool: Message = { id: "ut", role: "user", content: [{ type: "text", text: "search apple docs" }], createdAt: 10 };
    const aCall: Message = { id: "ac", role: "assistant", content: [{ type: "tool_call", toolCall: { id: "tc1", name: "search", arguments: { q: "apple" } } }], createdAt: 11 };
    const tRes: Message = { id: "tr", role: "tool", content: [{ type: "tool_result", toolResult: { toolCallId: "tc1", name: "search", result: "apple result" } }], createdAt: 12 };
    const uWeather = txt("user", "weather"); const aWeather = txt("assistant", "sunny");
    const uStock = txt("user", "stocks"); const aStock = txt("assistant", "up");
    const uRecent: Message = { id: "ur", role: "user", content: [{ type: "text", text: "more apple please" }], createdAt: 20 };

    const cm = createKeywordRetrievalContextManager({ topK: 1 });
    const out = cm.assembleContext([sys, uTool, aCall, tRes, uWeather, aWeather, uStock, aStock, uRecent], 1);
    const outIds = ids(out);
    // The apple tool turn is selected → its tool_call AND tool_result both present.
    expect(outIds).toContain("ac");
    expect(outIds).toContain("tr");
  });

  it("plugin factory registers a contextManager", async () => {
    const plugin = createKeywordRetrievalContextPlugin();
    expect(plugin.manifest.skandha).toBe("samjna");
    const hooks = await plugin.factory({} as any);
    expect(hooks.contextManager).toBeDefined();
    expect(typeof hooks.contextManager!.assembleContext).toBe("function");
  });
});
