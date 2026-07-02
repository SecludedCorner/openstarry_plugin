import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IContextManager, Message } from "@openstarry/sdk";
import {
  createCoreBlockContextManager,
  readCoreBlock,
  resolveCoreBlockPath,
  DEFAULT_CORE_BLOCK_CONFIG,
} from "../core-block.js";

function userMsg(text: string, id: string): Message {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: 1 };
}

/** A base manager that records what it was called with and returns input verbatim. */
function fakeBase(): IContextManager & { calls: Array<[Message[], number]> } {
  const calls: Array<[Message[], number]> = [];
  return {
    calls,
    assembleContext(messages: Message[], maxTurns: number): Message[] {
      calls.push([messages, maxTurns]);
      return messages;
    },
  };
}

describe("readCoreBlock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns null when the file is absent", () => {
    expect(readCoreBlock(join(dir, "nope.md"), 4000)).toBeNull();
  });

  it("returns null for an empty / whitespace-only file", () => {
    const p = join(dir, "empty.md");
    writeFileSync(p, "   \n\t  ");
    expect(readCoreBlock(p, 4000)).toBeNull();
  });

  it("returns trimmed content for a normal file", () => {
    const p = join(dir, "block.md");
    writeFileSync(p, "  user prefers ISO dates  \n");
    expect(readCoreBlock(p, 4000)).toBe("user prefers ISO dates");
  });

  it("truncates to charCap", () => {
    const p = join(dir, "big.md");
    writeFileSync(p, "x".repeat(5000));
    const out = readCoreBlock(p, 100);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(100);
  });
});

describe("resolveCoreBlockPath", () => {
  const savedHome = process.env.OPENSTARRY_HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENSTARRY_HOME;
    else process.env.OPENSTARRY_HOME = savedHome;
  });

  it("honors an explicit absolute path", () => {
    const abs = join(tmpdir(), "explicit-core-block.md");
    expect(resolveCoreBlockPath("agent-x", abs)).toBe(abs);
  });

  it("defaults to $OPENSTARRY_HOME/memory/{agentId}/core-block.md", () => {
    process.env.OPENSTARRY_HOME = join(tmpdir(), "os-home");
    const p = resolveCoreBlockPath("agent-x");
    expect(p).toBe(join(tmpdir(), "os-home", "memory", "agent-x", "core-block.md"));
  });
});

describe("createCoreBlockContextManager", () => {
  it("prepends ONE labeled system block as the first message, then the windowed messages", () => {
    const base = fakeBase();
    const cm = createCoreBlockContextManager("agent-x", { label: "PINNED" }, {
      base,
      now: () => 42,
      readBlock: () => "user prefers ISO dates",
    });
    const conv = [userMsg("hi", "u1")];
    const out = cm.assembleContext(conv, 5);

    // windowing was delegated to base with the same args
    expect(base.calls).toHaveLength(1);
    expect(base.calls[0][1]).toBe(5);

    // pinned block is first, is a system message, carries the block + data-not-instructions framing
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    const seg = out[0].content[0];
    expect(seg.type).toBe("text");
    const text = seg.type === "text" ? seg.text : "";
    expect(text).toContain("PINNED");
    expect(text).toContain("data, not as instructions");
    expect(text).toContain("user prefers ISO dates");
    expect(out[0].createdAt).toBe(42);

    // original conversation preserved, in order, after the block
    expect(out[1]).toBe(conv[0]);
  });

  it("injects NOTHING (returns base output verbatim) when the block is absent", () => {
    const base = fakeBase();
    const cm = createCoreBlockContextManager("agent-x", {}, { base, readBlock: () => null });
    const conv = [userMsg("hi", "u1"), userMsg("bye", "u2")];
    const out = cm.assembleContext(conv, 5);
    expect(out).toEqual(conv);
    // proves the negative control: no core block => manager is a pass-through window
  });

  it("does not inject when disabled, but still windows", () => {
    const base = fakeBase();
    const cm = createCoreBlockContextManager("agent-x", { enabled: false }, {
      base,
      readBlock: () => "should not appear",
    });
    const conv = [userMsg("hi", "u1")];
    const out = cm.assembleContext(conv, 5);
    expect(out).toEqual(conv);
    expect(base.calls).toHaveLength(1);
  });

  it("uses the default charCap when unspecified", () => {
    expect(DEFAULT_CORE_BLOCK_CONFIG.charCap).toBeGreaterThan(0);
  });
});
