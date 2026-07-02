import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISeed } from "@openstarry/sdk";
import {
  createBijaStore,
  createDistributedAlaya,
  createSeedSignatureService,
} from "@openstarry-plugin/distributed-alaya";
import {
  resolveSeedStorePath,
  loadSeedsFromDisk,
  writeSeedsToDisk,
  createDebouncer,
} from "../persistence.js";

describe("resolveSeedStorePath", () => {
  const saved = process.env.OPENSTARRY_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENSTARRY_HOME;
    else process.env.OPENSTARRY_HOME = saved;
  });

  it("honors an explicit absolute path", () => {
    const abs = join(tmpdir(), "seeds.json");
    expect(resolveSeedStorePath("a", abs)).toBe(abs);
  });

  it("defaults to $OPENSTARRY_HOME/memory/{agentId}/alaya-seeds.json", () => {
    process.env.OPENSTARRY_HOME = join(tmpdir(), "os");
    expect(resolveSeedStorePath("a")).toBe(join(tmpdir(), "os", "memory", "a", "alaya-seeds.json"));
  });
});

describe("writeSeedsToDisk / loadSeedsFromDisk", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "md-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns [] for an absent or corrupt file", () => {
    expect(loadSeedsFromDisk(join(dir, "nope.json"))).toEqual([]);
    writeSeedsToDiskRaw(join(dir, "bad.json"), "{ not json");
    expect(loadSeedsFromDisk(join(dir, "bad.json"))).toEqual([]);
  });

  it("creates parent dirs and round-trips seeds", () => {
    const path = join(dir, "nested", "deep", "alaya-seeds.json");
    const seed = mkSeed("s1");
    writeSeedsToDisk(path, [seed], () => 999);
    expect(existsSync(path)).toBe(true);
    expect(loadSeedsFromDisk(path)).toEqual([seed]);
  });
});

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid schedules into one trailing call", () => {
    const fn = vi.fn();
    const d = createDebouncer(100);
    d.schedule(fn); d.schedule(fn); d.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() runs the pending fn immediately; cancel() drops it", () => {
    const fn = vi.fn();
    const d = createDebouncer(100);
    d.schedule(fn);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    const fn2 = vi.fn();
    d.schedule(fn2);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn2).not.toHaveBeenCalled();
  });
});

describe("persistence round-trip fidelity (bottom line A)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "md-rt-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("re-plant on load preserves every field verbatim; only the signature regenerates", async () => {
    const path = join(dir, "alaya-seeds.json");

    // Session 1: plant into a real store, snapshot, persist.
    const sig1 = createSeedSignatureService();
    const bija1 = createBijaStore("agent-x", sig1);
    const alaya1 = createDistributedAlaya("agent-x", bija1, sig1);
    await alaya1.plant(mkSeed("s1", { type: "correction", text: "Use ISO dates", importance: 9 }));
    const snap1 = await alaya1.snapshot();
    writeSeedsToDisk(path, snap1.seeds);
    const savedSeed = snap1.seeds[0];
    expect(savedSeed.nonce).toBeTypeOf("number"); // alaya stamped a nonce
    expect(savedSeed.signature).toBeTypeOf("string");

    // Session 2: fresh process/key — load and re-plant.
    const loaded = loadSeedsFromDisk(path);
    const sig2 = createSeedSignatureService();
    const bija2 = createBijaStore("agent-x", sig2);
    const alaya2 = createDistributedAlaya("agent-x", bija2, sig2);
    for (const s of loaded) await alaya2.plant(s);
    const q = await alaya2.query({});

    expect(q).toHaveLength(1);
    const reloaded = q[0];
    // Field-for-field identical...
    expect(stripSig(reloaded)).toEqual(stripSig(savedSeed));
    expect(reloaded.seedId).toBe(savedSeed.seedId);
    expect(reloaded.createdAt).toBe(savedSeed.createdAt);
    expect(reloaded.updatedAt).toBe(savedSeed.updatedAt);
    expect(reloaded.nonce).toBe(savedSeed.nonce);
    expect(reloaded.content).toEqual({ type: "correction", text: "Use ISO dates", importance: 9 });
    // ...except the in-process HMAC signature, which is regenerated.
    expect(reloaded.signature).toBeTypeOf("string");
  });
});

// ---- helpers ----
function mkSeed(seedId: string, content: unknown = { type: "preference", text: "x", importance: 5 }): ISeed {
  return {
    seedId,
    agentId: "agent-x",
    skandha: "samskara",
    content,
    visibility: "private",
    createdAt: 111,
    updatedAt: 111,
  };
}
function stripSig(s: ISeed): Omit<ISeed, "signature"> {
  const { signature: _s, ...rest } = s;
  return rest;
}
function writeSeedsToDiskRaw(path: string, raw: string): void {
  // deliberately write invalid JSON for the corrupt-file test
  writeFileSync(path, raw, "utf8");
}
