/**
 * Spec Addendum 2026-06-15 (ISeed Replay-Nonce) — behavior proof.
 *
 * The frozen ISeed interface gained an optional `nonce`; DistributedAlayaImpl.plant()
 * stamps a strictly-increasing per-agent nonce, and the cross-process receiver
 * acceptRemote() rejects a replayed/reordered seed via the signature service's
 * per-agent monotonic verifyNonce (SEC-001, previously built but never wired).
 *
 * These tests exercise the receiver path directly (no two processes needed):
 *  - a byte-identical replayed seed is rejected (fail-closed),
 *  - a lower (reordered) nonce is rejected,
 *  - tampering the nonce breaks the HMAC (caught at verify, before the nonce check),
 *  - a seed WITHOUT a nonce takes the legacy path unchanged (backward compat),
 *  - plant() auto-stamps a strictly-increasing nonce.
 */

import { describe, it, expect } from "vitest";
import { createDistributedAlaya } from "../distributed-alaya-impl.js";
import { createBijaStore } from "../bija-store.js";
import { SeedSignatureServiceImpl } from "../seed-signature.js";
import type { ISeed } from "@openstarry/sdk";

// Shared cluster key so sender-sign / receiver-verify is a genuine cross-agent
// integrity check (HMAC Option A), not a tautological self-verification.
const CLUSTER_KEY = Buffer.alloc(32, 0x5a);

function makeSeed(agentId: string, overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId: `seed-${agentId}-1`,
    agentId,
    skandha: "vijnana",
    content: { data: "test" },
    visibility: "private",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeReceiver() {
  const svc = new SeedSignatureServiceImpl(Buffer.from(CLUSTER_KEY));
  const store = createBijaStore("receiver", svc);
  const alaya = createDistributedAlaya("receiver", store, svc);
  return { svc, store, alaya };
}

async function signedSeedFrom(agentId: string, overrides: Partial<ISeed>): Promise<ISeed> {
  const senderSvc = new SeedSignatureServiceImpl(Buffer.from(CLUSTER_KEY));
  const seed = makeSeed(agentId, overrides);
  const signature = await senderSvc.sign(seed);
  return { ...seed, signature };
}

describe("ISeed replay-nonce (Spec Addendum 2026-06-15)", () => {
  it("acceptRemote accepts a nonced seed once, then rejects a byte-identical replay (fail-closed)", async () => {
    const { alaya, store } = makeReceiver();
    const signed = await signedSeedFrom("agent-a", { seedId: "s1", nonce: 1000 });

    await expect(alaya.acceptRemote(signed, {})).resolves.toBeUndefined();
    expect(store.size()).toBe(1);

    // Exact same signed bytes replayed — same valid signature, same nonce.
    await expect(alaya.acceptRemote(signed, {})).rejects.toThrow(/nonce replay\/reorder rejected/);
    expect(store.size()).toBe(1); // store untouched by the rejected replay
  });

  it("acceptRemote rejects a lower (reordered) nonce from the same agent", async () => {
    const { alaya } = makeReceiver();
    const high = await signedSeedFrom("agent-a", { seedId: "s-high", nonce: 2000 });
    const low = await signedSeedFrom("agent-a", { seedId: "s-low", nonce: 1500 });

    await expect(alaya.acceptRemote(high, {})).resolves.toBeUndefined();
    await expect(alaya.acceptRemote(low, {})).rejects.toThrow(/nonce replay\/reorder rejected/);
  });

  it("nonce is covered by the HMAC: tampering it fails verify() before the nonce check", async () => {
    const { alaya } = makeReceiver();
    const signed = await signedSeedFrom("agent-a", { seedId: "s1", nonce: 1000 });
    const tampered: ISeed = { ...signed, nonce: 9999 }; // signature no longer matches canonical

    await expect(alaya.acceptRemote(tampered, {})).rejects.toThrow(/HMAC verification failed/);
  });

  it("per-agent independence: a replay from agent-a does not block a first seed from agent-b", async () => {
    const { alaya } = makeReceiver();
    const a = await signedSeedFrom("agent-a", { seedId: "sa", nonce: 1000 });
    const b = await signedSeedFrom("agent-b", { seedId: "sb", nonce: 1000 });

    await expect(alaya.acceptRemote(a, {})).resolves.toBeUndefined();
    // same nonce value but different agent — independent counter, must accept
    await expect(alaya.acceptRemote(b, {})).resolves.toBeUndefined();
  });

  it("backward compat: a seed WITHOUT a nonce takes the legacy path (no replay check)", async () => {
    const { alaya, store } = makeReceiver();
    const signed = await signedSeedFrom("agent-a", { seedId: "legacy" }); // no nonce

    await expect(alaya.acceptRemote(signed, {})).resolves.toBeUndefined();
    // legacy idempotent re-accept does NOT throw a replay error (last-writer-wins)
    await expect(alaya.acceptRemote(signed, {})).resolves.toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it("plant() auto-stamps a strictly-increasing nonce when the caller omits one", async () => {
    const svc = new SeedSignatureServiceImpl(Buffer.from(CLUSTER_KEY));
    const store = createBijaStore("agent-a", svc);
    const alaya = createDistributedAlaya("agent-a", store, svc);

    await alaya.plant(makeSeed("agent-a", { seedId: "p1" }));
    await alaya.plant(makeSeed("agent-a", { seedId: "p2" }));

    const seeds = await alaya.query({ agentId: "agent-a" });
    const byId = Object.fromEntries(seeds.map((s) => [s.seedId, s]));
    expect(typeof byId["p1"].nonce).toBe("number");
    expect(typeof byId["p2"].nonce).toBe("number");
    expect(byId["p2"].nonce!).toBeGreaterThan(byId["p1"].nonce!);
  });
});
