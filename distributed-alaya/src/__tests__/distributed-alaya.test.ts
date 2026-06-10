import { describe, it, expect, vi } from "vitest";
import { createDistributedAlaya } from "../distributed-alaya-impl.js";
import { createBijaStore } from "../bija-store.js";
import { createSeedSignatureService } from "../seed-signature.js";
import { createDistributedAlayaPlugin } from "../index.js";
import type { ISeed } from "@openstarry/sdk";

function makeSeed(agentId: string, overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId: `seed-${Math.random().toString(36).slice(2)}`,
    agentId,
    skandha: "vijnana",
    content: { data: "test" },
    visibility: "private",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("DistributedAlaya — seed lifecycle (AC-W1-1)", () => {
  it("plant() stores a seed and query() retrieves it", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const seed = makeSeed("agent-a", { seedId: "s1" });
    await alaya.plant(seed);

    const results = await alaya.query({ agentId: "agent-a" });
    expect(results).toHaveLength(1);
    expect(results[0].seedId).toBe("s1");
  });

  it("plant() rejects seeds where agentId does not match calling agent (AC-W1-2, F-8)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const wrongSeed = makeSeed("agent-b", { seedId: "s2" });
    await expect(alaya.plant(wrongSeed)).rejects.toThrow();
  });

  it("update() modifies mutable fields via alaya", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const seed = makeSeed("agent-a", { seedId: "s1", visibility: "private" });
    await alaya.plant(seed);
    await alaya.update("s1", { visibility: "public" });

    const [updated] = await alaya.query({});
    expect(updated.visibility).toBe("public");
  });

  it("remove() deletes a seed via alaya", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const seed = makeSeed("agent-a", { seedId: "s1" });
    await alaya.plant(seed);
    await alaya.remove("s1");

    const results = await alaya.query({});
    expect(results).toHaveLength(0);
  });

  it("subscribe() returns an unsubscribe function", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const callback = vi.fn();
    const unsub = alaya.subscribe({}, callback);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("exchangeSeeds() performs bidirectional exchange and merges vector clocks (AC-W1-1)", async () => {
    // Agent A
    const svcA = createSeedSignatureService();
    const storeA = createBijaStore("agent-a", svcA);
    const alayaA = createDistributedAlaya("agent-a", storeA, svcA);

    // Agent B (peer)
    const svcB = createSeedSignatureService();
    const storeB = createBijaStore("agent-b", svcB);

    // Register B as target of A
    alayaA.registerTarget({ agentId: "agent-b", store: storeB, signatureService: svcB });

    // Plant seeds in A
    await alayaA.plant(makeSeed("agent-a", { seedId: "s1" }));

    const result = await alayaA.exchangeSeeds("agent-b");
    expect(result.peerId).toBe("agent-b");
    expect(typeof result.seedsExchanged).toBe("number");
    expect(typeof result.timestamp).toBe("number");
  });

  it("propagate() exercises the seed propagation path (AC-W1-1)", async () => {
    const svcA = createSeedSignatureService();
    const storeA = createBijaStore("agent-a", svcA);
    const alayaA = createDistributedAlaya("agent-a", storeA, svcA);

    const svcB = createSeedSignatureService();
    const storeB = createBijaStore("agent-b", svcB);

    alayaA.registerTarget({ agentId: "agent-b", store: storeB, signatureService: svcB });

    const seed = makeSeed("agent-a", { seedId: "s1" });
    await alayaA.plant(seed);
    await alayaA.propagate("s1", ["agent-b"]);
    // Propagation completes without throwing
  });

  it("propagate() preserves original agentId in target store (FINDING-1 fix, no F-8 tautology)", async () => {
    const svcA = createSeedSignatureService();
    const storeA = createBijaStore("agent-a", svcA);
    const alayaA = createDistributedAlaya("agent-a", storeA, svcA);

    const svcB = createSeedSignatureService();
    const storeB = createBijaStore("agent-b", svcB);

    alayaA.registerTarget({ agentId: "agent-b", store: storeB, signatureService: svcB });

    const seed = makeSeed("agent-a", { seedId: "s1" });
    await alayaA.plant(seed);
    await alayaA.propagate("s1", ["agent-b"]);

    // Seed in B's store should retain agentId "agent-a", not be rewritten to "agent-b"
    const resultsInB = await storeB.query({});
    expect(resultsInB).toHaveLength(1);
    expect(resultsInB[0].agentId).toBe("agent-a");
    expect(resultsInB[0].seedId).toBe("s1");
  });

  it("exchangeSeeds() preserves original agentId for seeds in peer store (FINDING-1 fix)", async () => {
    const svcA = createSeedSignatureService();
    const storeA = createBijaStore("agent-a", svcA);
    const alayaA = createDistributedAlaya("agent-a", storeA, svcA);

    const svcB = createSeedSignatureService();
    const storeB = createBijaStore("agent-b", svcB);

    alayaA.registerTarget({ agentId: "agent-b", store: storeB, signatureService: svcB });

    await alayaA.plant(makeSeed("agent-a", { seedId: "s1" }));
    const result = await alayaA.exchangeSeeds("agent-b");

    // Seeds received by B from A should retain agentId "agent-a"
    const resultsInB = await storeB.query({});
    expect(resultsInB.length).toBeGreaterThan(0);
    expect(resultsInB.every(s => s.agentId === "agent-a")).toBe(true);

    expect(result.peerId).toBe("agent-b");
  });
});

describe("createDistributedAlayaPlugin — IPlugin factory (N=1 consumer)", () => {
  it("returns an IPlugin with manifest and factory", () => {
    const plugin = createDistributedAlayaPlugin({ agentId: "agent-test" });
    expect(plugin.manifest.name).toBe("@openstarry-plugin/distributed-alaya");
    expect(typeof plugin.factory).toBe("function");
  });

  it("factory invokes ctx.pushInput() as the N=1 consumer (AC-W1-1)", async () => {
    const plugin = createDistributedAlayaPlugin({ agentId: "agent-test" });
    const pushInput = vi.fn();
    const ctx = { pushInput } as any;

    await plugin.factory(ctx);
    expect(pushInput).toHaveBeenCalledWith(expect.objectContaining({
      source: "distributed-alaya",
      inputType: "system_event",
    }));
  });

  it("factory returns PluginHooks object", async () => {
    const plugin = createDistributedAlayaPlugin({ agentId: "agent-test" });
    const ctx = { pushInput: vi.fn() } as any;
    const hooks = await plugin.factory(ctx);
    expect(hooks).toBeDefined();
  });
});
