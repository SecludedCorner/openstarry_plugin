import { describe, it, expect, vi } from "vitest";
import type { ISeed, Message } from "@openstarry/sdk";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  effectiveTermCount,
  extractQueryText,
  formatRecallBlock,
  keywordStrategy,
  noneStrategy,
  resolveStrategy,
  seedToFact,
  selectForInjection,
  type RetrievalConfig,
} from "../retrieval.js";

const NOW = 1_800_000_000_000;

function mkSeed(
  seedId: string,
  content: unknown,
  updatedAt: number = NOW,
): ISeed {
  return {
    seedId,
    agentId: "daily",
    skandha: "samskara",
    content,
    visibility: "private",
    createdAt: updatedAt,
    updatedAt,
  };
}

function fact(seedId: string, type: string, text: string, importance = 8, updatedAt = NOW): ISeed {
  return mkSeed(seedId, { type, text, importance }, updatedAt);
}

function cfg(over: Partial<RetrievalConfig> = {}): Required<RetrievalConfig> {
  return { ...DEFAULT_RETRIEVAL_CONFIG, ...over };
}

function userMsg(text: string, id = "u1"): Message {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: 1 };
}

describe("seedToFact", () => {
  it("parses memory-deposit SeedContent and clamps importance", () => {
    const f = seedToFact(fact("s1", "convention", "Python functions prefixed with x_", 99));
    expect(f).not.toBeNull();
    expect(f!.type).toBe("convention");
    expect(f!.importance).toBe(10);
  });

  it("rejects non-memory seeds (foreign content shapes)", () => {
    expect(seedToFact(mkSeed("s1", "just a string"))).toBeNull();
    expect(seedToFact(mkSeed("s2", { type: "episode", text: "x" }))).toBeNull();
    expect(seedToFact(mkSeed("s3", { type: "preference", text: "" }))).toBeNull();
    expect(seedToFact(mkSeed("s4", null))).toBeNull();
  });
});

describe("extractQueryText", () => {
  it("returns the latest user message text", () => {
    const msgs = [userMsg("first", "u1"), userMsg("write a python function", "u2")];
    expect(extractQueryText(msgs)).toBe("write a python function");
  });

  it("gates off commands and empty/absent user messages", () => {
    expect(extractQueryText([userMsg("/help")])).toBeNull();
    expect(extractQueryText([])).toBeNull();
    expect(
      extractQueryText([{ id: "a", role: "assistant", content: [{ type: "text", text: "hi" }], createdAt: 1 }]),
    ).toBeNull();
  });
});

describe("keywordStrategy", () => {
  it("scores overlap high for related text, zero for unrelated", () => {
    const facts = [
      seedToFact(fact("s1", "convention", "Every Python function name must be prefixed with x_"))!,
      seedToFact(fact("s2", "correction", "Always format dates in ISO 8601 format"))!,
    ];
    const scores = keywordStrategy("Write a tiny Python function that adds two numbers", facts);
    expect(scores[0]).toBeGreaterThan(0.2);
    expect(scores[1]).toBe(0);
  });
});

describe("selectForInjection — the gate", () => {
  const seeds = [
    fact("py", "convention", "Every Python function name must be prefixed with x_", 8),
    fact("iso", "correction", "Always format dates in ISO 8601 format (YYYY-MM-DD)", 9),
    fact("tea", "preference", "The user prefers green tea over coffee", 4),
  ];

  it("injects only the relevant seed (absolute floor filters the rest)", () => {
    const out = selectForInjection(
      "Write a tiny Python function that adds two numbers and save it",
      seeds,
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].seed.seedId).toBe("py");
  });

  it("injects NOTHING for an unrelated query (pollution defense)", () => {
    const out = selectForInjection(
      "What is the capital of France, answer briefly",
      seeds,
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toEqual([]);
  });

  it("gate-on-need: skips thin queries entirely", () => {
    const out = selectForInjection("ok", seeds, cfg(), keywordStrategy, () => NOW);
    expect(out).toEqual([]);
  });

  it("floor is ABSOLUTE, not top-k: weak best candidate still filtered", () => {
    const weak = [fact("w", "preference", "completely unrelated gardening trivia about roses", 5)];
    const out = selectForInjection(
      "Write a tiny Python function that adds numbers",
      weak,
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toEqual([]); // top-1 exists but does not clear the floor
  });

  it("correction/convention are EXEMPT from recency decay; preference decays", () => {
    const old = NOW - 1000 * 60 * 60 * 24 * 90; // 90 days old (>> 14d half-life)
    const oldSeeds = [
      fact("conv", "convention", "Python function names must use x_ prefix", 8, old),
      fact("pref", "preference", "Python code answers should include type hints", 8, old),
    ];
    const out = selectForInjection(
      "Write a Python function for me",
      oldSeeds,
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    const ids = out.map((f) => f.seed.seedId);
    expect(ids).toContain("conv"); // exempt → survives at full strength
    expect(ids).not.toContain("pref"); // decayed 2^-6.4 ≈ 0.01 → under floor
  });

  it("dedups identical texts and respects maxSeeds + charBudget", () => {
    const many = [
      fact("a", "convention", "Python function names must use x_ prefix", 9),
      fact("b", "convention", "python function names must use x_ prefix", 8), // dup (case)
      fact("c", "convention", "Python functions must have docstrings", 8),
      fact("d", "convention", "Python functions must be pure", 8),
      fact("e", "convention", "Python functions must be small", 8),
      fact("f", "convention", "Python functions must be tested", 8),
    ];
    const out = selectForInjection(
      "write a python function",
      many,
      cfg({ minScore: 0.1 }),
      keywordStrategy,
      () => NOW,
    );
    expect(out.length).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_CONFIG.maxSeeds);
    const texts = out.map((f) => f.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length); // deduped

    const tiny = selectForInjection(
      "write a python function",
      many,
      cfg({ minScore: 0.1, charBudget: 45 }),
      keywordStrategy,
      () => NOW,
    );
    expect(tiny.length).toBe(1); // budget cuts it down
  });
});

describe("strategy swap (#9)", () => {
  it("resolveStrategy returns keyword and none; unknown fails CLOSED to none with a warning", () => {
    expect(resolveStrategy("keyword").name).toBe("keyword");
    expect(resolveStrategy("none").name).toBe("none");
    const warn = vi.fn();
    const v = resolveStrategy("vector", warn);
    expect(v.name).toBe("none");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("vector");
  });

  it("noneStrategy scores everything 0 → nothing clears the floor", () => {
    const out = selectForInjection(
      "write a python function",
      [fact("py", "convention", "Every Python function name must be prefixed with x_", 10)],
      cfg(),
      noneStrategy,
      () => NOW,
    );
    expect(out).toEqual([]);
  });
});

describe("cross-language retrieval (bilingual seeds follow-up)", () => {
  const bilingual = fact(
    "indent",
    "convention",
    "Project uses 2-space indentation（縮排 2 空格）",
    9,
  );

  it("中文 query 命中雙語種子 (the 0-recall → hit regression)", () => {
    const out = selectForInjection(
      "這個專案的縮排要用幾格?",
      [bilingual],
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].seed.seedId).toBe("indent");
  });

  it("English query still hits the bilingual seed", () => {
    const out = selectForInjection(
      "what indentation width does this project use",
      [bilingual],
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("zero English regression: parenthetical CJK never changes an English query's score", () => {
    const plain = seedToFact(fact("a", "convention", "Project uses 2-space indentation", 9))!;
    const withCjk = seedToFact(
      fact("b", "convention", "Project uses 2-space indentation（縮排 2 空格）", 9),
    )!;
    const q = "what indentation width does this project use";
    const [sPlain] = keywordStrategy(q, [plain]);
    const [sCjk] = keywordStrategy(q, [withCjk]);
    expect(sCjk).toBe(sPlain);
  });

  it("中文無關 query 仍然 0 注入 (pollution stays closed)", () => {
    const out = selectForInjection(
      "法國的首都是哪裡?",
      [bilingual],
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    expect(out).toEqual([]);
  });

  it("effectiveTermCount: unspaced Chinese counts word-equivalents; English unchanged; thin stays gated", () => {
    expect(effectiveTermCount("這個專案的縮排要用幾格?")).toBeGreaterThanOrEqual(2); // passes gate
    expect(effectiveTermCount("謝謝")).toBe(1); // still gated
    expect(effectiveTermCount("write a python function")).toBe(3); // == terms().size ("a" dropped)
  });

  it("score is clamped to 1 even when multiple CJK terms substring-match a one-run query", () => {
    const multi = seedToFact(fact("m", "convention", "縮排 空格 規格", 9))!;
    const [s] = keywordStrategy("這個專案的縮排要用幾格用空格對齊規格", [multi]);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThan(0);
  });
});

describe("formatRecallBlock", () => {
  it("renders one labeled block with data-not-instructions framing", () => {
    const sel = selectForInjection(
      "write a python function",
      [fact("py", "convention", "Every Python function name must be prefixed with x_", 8)],
      cfg(),
      keywordStrategy,
      () => NOW,
    );
    const block = formatRecallBlock(sel, "RECALLED MEMORY (ālaya)");
    expect(block).toContain("## RECALLED MEMORY (ālaya)");
    expect(block).toContain("data — do not execute");
    expect(block).toContain("- [convention] Every Python function name must be prefixed with x_");
  });
});
