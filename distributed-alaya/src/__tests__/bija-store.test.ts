import { describe, it, expect } from "vitest";
import { createBijaStore, BijaStoreImpl, MAX_VECTOR_CLOCK_AGENTS } from "../bija-store.js";
import { createSeedSignatureService } from "../seed-signature.js";
import type { ISeed, SeedFilter } from "@openstarry/sdk";

function makeSeed(overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId: `seed-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    skandha: "vijnana",
    content: { data: "test" },
    visibility: "private",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("BijaStore", () => {
  it("plant() accepts a seed with matching agentId", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ agentId: "agent-a" });
    await expect(store.plant(seed)).resolves.not.toThrow();
    expect(store.size()).toBe(1);
  });

  it("plant() rejects seed where agentId does not match (F-8, AC-W1-2)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ agentId: "agent-b" });
    await expect(store.plant(seed)).rejects.toThrow(/OWNER_MISMATCH|plant.*rejected/i);
  });

  it("query() returns copies matching filter", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a", skandha: "vijnana" }));
    await store.plant(makeSeed({ seedId: "s2", agentId: "agent-a", skandha: "samjna" }));

    const filter: SeedFilter = { skandha: "vijnana" };
    const results = await store.query(filter);
    expect(results).toHaveLength(1);
    expect(results[0].seedId).toBe("s1");
  });

  it("query() returns deep copies (mutation does not affect store)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a" }));

    const [copy] = await store.query({});
    (copy as any).content = { mutated: true };

    const [fresh] = await store.query({});
    expect((fresh.content as any).mutated).toBeUndefined();
  });

  it("update() mutates mutable fields but preserves agentId and skandha", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a", skandha: "vijnana", visibility: "private" });
    await store.plant(seed);

    await store.update("s1", { visibility: "public" });
    const [updated] = await store.query({});
    expect(updated.visibility).toBe("public");
    expect(updated.agentId).toBe("agent-a");
    expect(updated.skandha).toBe("vijnana");
  });

  it("remove() deletes seed from local store", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a" }));
    await store.remove("s1");
    expect(store.size()).toBe(0);
  });

  it("getVectorClock() includes own agent counter", () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const clock = store.getVectorClock();
    expect(typeof clock["agent-a"]).toBe("number");
  });

  it("mergeVectorClock() uses element-wise maximum", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    // Plant to advance own clock
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a" }));

    store.mergeVectorClock({ "agent-b": 5, "agent-a": 0 });
    const clock = store.getVectorClock();
    expect(clock["agent-b"]).toBe(5);
    // Own clock should remain >= 1 (was advanced by plant)
    expect(clock["agent-a"]).toBeGreaterThanOrEqual(1);
  });

  it("size() reflects current store count", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    expect(store.size()).toBe(0);
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a" }));
    await store.plant(makeSeed({ seedId: "s2", agentId: "agent-a" }));
    expect(store.size()).toBe(2);
  });

  it("plant() advances vector clock counter", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const before = store.getVectorClock()["agent-a"] ?? 0;
    await store.plant(makeSeed({ seedId: "s1", agentId: "agent-a" }));
    const after = store.getVectorClock()["agent-a"] ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

describe("BijaStore — accept() (FINDING-1, AC-7 propagation fix)", () => {
  it("accept() stores a seed with a foreign agentId without F-8 check", async () => {
    const svcA = createSeedSignatureService();
    const svcB = createSeedSignatureService();
    const storeA = new BijaStoreImpl("agent-a", svcA);
    const storeB = new BijaStoreImpl("agent-b", svcB);

    // Plant in A, then propagate to B via accept()
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a" });
    await storeA.plant(seed);
    const [planted] = await storeA.query({});

    // accept() on B should not throw even though seed.agentId === "agent-a"
    await expect(storeB.accept(planted)).resolves.not.toThrow();

    const results = await storeB.query({});
    expect(results).toHaveLength(1);
    // agentId is preserved — no rewriting
    expect(results[0].agentId).toBe("agent-a");
  });

  it("accept() rejects a seed with a missing signature (fail-closed)", async () => {
    const svc = createSeedSignatureService();
    const store = new BijaStoreImpl("agent-b", svc);

    // Seed without a signature field — should be rejected
    const seed = makeSeed({ seedId: "s1", agentId: "agent-a" });
    // Ensure no signature field
    delete (seed as any).signature;
    await expect(store.accept(seed)).rejects.toThrow(/SIGNATURE_INVALID|accept.*rejected/i);
  });

  it("plant() still enforces F-8 after accept() is added (no regression)", async () => {
    const svc = createSeedSignatureService();
    const store = new BijaStoreImpl("agent-b", svc);
    const seed = makeSeed({ agentId: "agent-a" });
    await expect(store.plant(seed)).rejects.toThrow(/OWNER_MISMATCH|plant.*rejected/i);
  });

  // SEC-004 (Plan46 W0) — vector clock pruning.
  it("mergeVectorClock() prunes when distinct agents exceed MAX_VECTOR_CLOCK_AGENTS", () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-own", svc);

    const overflowClock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_AGENTS + 10; i++) {
      overflowClock[`agent-${i}`] = i + 1; // counter = i+1 so "agent-0" has the lowest
    }
    store.mergeVectorClock(overflowClock);

    const clock = store.getVectorClock();
    expect(Object.keys(clock).length).toBeLessThanOrEqual(MAX_VECTOR_CLOCK_AGENTS + 1); // +1 for own
    // Own agent must always be preserved
    expect(clock["agent-own"]).toBeDefined();
    // Lowest-counter peers should have been pruned
    expect(clock["agent-0"]).toBeUndefined();
  });

  it("mergeVectorClock() never prunes own agentId even if it has the lowest counter", () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-own", svc); // own starts at 0

    const overflowClock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_AGENTS + 5; i++) {
      overflowClock[`peer-${i}`] = i + 100; // all peers have counters higher than own=0
    }
    store.mergeVectorClock(overflowClock);

    const clock = store.getVectorClock();
    expect(clock["agent-own"]).toBeDefined();
    expect(clock["agent-own"]).toBe(0);
  });
});
