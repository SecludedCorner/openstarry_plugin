import { describe, it, expect, vi } from "vitest";
import { createDistributedAlaya } from "../distributed-alaya-impl.js";
import { createBijaStore } from "../bija-store.js";
import { createSeedSignatureService } from "../seed-signature.js";
import type { ISeed, IAlayaSnapshot } from "@openstarry/sdk";

function makeSeed(agentId: string, seedId: string, overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId,
    agentId,
    skandha: "vijnana",
    content: { data: seedId },
    visibility: "private",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("Late-joiner snapshot (Plan41 W4)", () => {
  it("snapshot() returns a frozen seeds array with current vector clock", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    await alaya.plant(makeSeed("agent-a", "s1"));
    await alaya.plant(makeSeed("agent-a", "s2"));

    const snap = await alaya.snapshot();

    expect(snap.seeds).toHaveLength(2);
    expect(Object.isFrozen(snap.seeds)).toBe(true);
    expect(typeof snap.timestamp).toBe("number");
    expect(typeof snap.vectorClock).toBe("object");
    expect(snap.vectorClock["agent-a"]).toBeGreaterThan(0);
  });

  it("restoreSnapshot() verifies HMAC on each seed and rejects invalid signatures", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    await alaya.plant(makeSeed("agent-a", "s1"));
    const snap = await alaya.snapshot();

    // Replace verify to simulate a bad signature on one seed
    const badSvc = {
      sign: svc.sign.bind(svc),
      verify: vi.fn().mockResolvedValue(false),
    };

    const receiverStore = createBijaStore("agent-b", svc);
    const receiver = createDistributedAlaya("agent-b", receiverStore, svc);

    await expect(receiver.restoreSnapshot(snap, badSvc)).rejects.toThrow(
      /HMAC verification failed for seed/,
    );
  });

  it("restoreSnapshot() rejects snapshots older than the freshness threshold", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const staleSnap: IAlayaSnapshot = {
      seeds: Object.freeze([]),
      vectorClock: {},
      timestamp: Date.now() - 60000, // 60s old — exceeds default 30s
    };

    const receiverStore = createBijaStore("agent-b", svc);
    const receiver = createDistributedAlaya("agent-b", receiverStore, svc);

    await expect(receiver.restoreSnapshot(staleSnap, svc)).rejects.toThrow(
      /Snapshot too old/,
    );
  });

  it("restoreSnapshot() accepts snapshots within a custom freshness threshold", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    const snap: IAlayaSnapshot = {
      seeds: Object.freeze([]),
      vectorClock: {},
      timestamp: Date.now() - 45000, // 45s old
    };

    const receiverStore = createBijaStore("agent-b", svc);
    const receiver = createDistributedAlaya("agent-b", receiverStore, svc);

    // Custom threshold of 60s — should not throw
    await expect(receiver.restoreSnapshot(snap, svc, 60000)).resolves.toBeUndefined();
  });

  it("restoreSnapshot() merges vector clock from snapshot (G6)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    await alaya.plant(makeSeed("agent-a", "s1"));
    const snap = await alaya.snapshot();

    const receiverStore = createBijaStore("agent-b", svc);
    const receiver = createDistributedAlaya("agent-b", receiverStore, svc);

    await receiver.restoreSnapshot(snap, svc);

    const clock = receiverStore.getVectorClock();
    expect(clock["agent-a"]).toBeGreaterThan(0);
  });

  it("restoreSnapshot() is idempotent — applying same snapshot twice does not duplicate seeds (G5)", async () => {
    const svc = createSeedSignatureService();
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    await alaya.plant(makeSeed("agent-a", "s1"));
    const snap = await alaya.snapshot();

    const receiverStore = createBijaStore("agent-b", svc);
    const receiver = createDistributedAlaya("agent-b", receiverStore, svc);

    await receiver.restoreSnapshot(snap, svc);
    await receiver.restoreSnapshot(snap, svc);

    const results = await receiver.query({});
    // Only one copy of s1 should exist after idempotent restore
    const s1Count = results.filter(s => s.seedId === "s1").length;
    expect(s1Count).toBe(1);
  });
});
