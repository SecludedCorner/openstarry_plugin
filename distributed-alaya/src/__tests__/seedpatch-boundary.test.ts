import { describe, it, expect } from "vitest";
import { createBijaStore } from "../bija-store.js";
import { createSeedSignatureService } from "../seed-signature.js";
import type { ISeed } from "@openstarry/sdk";

function makeSeed(overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId: `seed-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    skandha: "vijnana",
    content: { data: "original" },
    visibility: "private",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("SeedPatch allowlist boundary (Finding 2-1)", () => {
  it("update() with allowed fields (content, visibility) succeeds", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a" });
    await store.plant(seed);

    await expect(
      store.update("s1", { content: { data: "updated" }, visibility: "public" }),
    ).resolves.not.toThrow();

    const [updated] = await store.query({});
    expect(updated.content).toEqual({ data: "updated" });
    expect(updated.visibility).toBe("public");
  });

  it("update() does NOT change immutable field skandha", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a", skandha: "vijnana" });
    await store.plant(seed);

    // SeedPatch type excludes skandha at compile time; runtime enforcement
    // strips it via the Pick allowlist extraction in update().
    // Cast to any to simulate a caller bypassing TypeScript.
    await store.update("s1", { content: { data: "x" } } as any);

    const [after] = await store.query({});
    expect(after.skandha).toBe("vijnana");
  });

  it("update() does NOT change immutable field agentId", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a" });
    await store.plant(seed);

    await store.update("s1", { content: { data: "x" } } as any);

    const [after] = await store.query({});
    expect(after.agentId).toBe("agent-a");
  });

  it("update() does NOT change immutable field seedId", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a" });
    await store.plant(seed);

    await store.update("s1", { content: { data: "x" } } as any);

    const [after] = await store.query({});
    expect(after.seedId).toBe("s1");
  });

  it("update() does NOT change immutable field createdAt", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a", createdAt: 1000 });
    await store.plant(seed);

    await store.update("s1", { content: { data: "x" } } as any);

    const [after] = await store.query({});
    expect(after.createdAt).toBe(1000);
  });

  it("update() sets updatedAt from the store (not from patch)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a", updatedAt: 1000 });
    await store.plant(seed);

    const beforeUpdate = Date.now();
    // Even if patch includes updatedAt, the store overwrites it with Date.now()
    await store.update("s1", { content: { data: "x" }, updatedAt: 9999999 });

    const [after] = await store.query({});
    // updatedAt must be set by the store (>= beforeUpdate), not taken from patch (9999999)
    expect(after.updatedAt).not.toBe(9999999);
    expect(after.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
  });
});
