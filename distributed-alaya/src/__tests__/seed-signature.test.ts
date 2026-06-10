import { describe, it, expect } from "vitest";
import { createSeedSignatureService, SeedSignatureServiceImpl } from "../seed-signature.js";
import type { ISeed } from "@openstarry/sdk";

function makeSeed(overrides: Partial<ISeed> = {}): ISeed {
  return {
    seedId: "seed-1",
    agentId: "agent-a",
    skandha: "vijnana",
    content: { key: "value" },
    visibility: "private",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("SeedSignatureService", () => {
  it("sign() returns a non-empty hex string", async () => {
    const svc = createSeedSignatureService();
    const seed = makeSeed();
    const sig = await svc.sign(seed);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify() returns true for a freshly signed seed", async () => {
    const svc = createSeedSignatureService();
    const seed = makeSeed();
    const signature = await svc.sign(seed);
    const signedSeed = { ...seed, signature };
    expect(await svc.verify(signedSeed)).toBe(true);
  });

  it("verify() returns false for a seed with no signature (fail-closed)", async () => {
    const svc = createSeedSignatureService();
    const seed = makeSeed();
    expect(await svc.verify(seed)).toBe(false);
  });

  it("verify() returns false for a tampered signature", async () => {
    const svc = createSeedSignatureService();
    const seed = makeSeed();
    const signature = await svc.sign(seed);
    const tampered = { ...seed, signature: signature.replace(/.$/, 'x') };
    expect(await svc.verify(tampered)).toBe(false);
  });

  it("verify() returns false when seed content is modified after signing", async () => {
    const svc = createSeedSignatureService();
    const seed = makeSeed();
    const signature = await svc.sign(seed);
    const modified = { ...seed, content: { key: "tampered" }, signature };
    expect(await svc.verify(modified)).toBe(false);
  });

  it("two services with different secrets produce different signatures", async () => {
    const svc1 = createSeedSignatureService();
    const svc2 = createSeedSignatureService();
    const seed = makeSeed();
    const sig1 = await svc1.sign(seed);
    const sig2 = await svc2.sign(seed);
    expect(sig1).not.toBe(sig2);
  });

  it("same service with same seed produces same signature", async () => {
    const secret = Buffer.alloc(32, 0x42);
    const svc = createSeedSignatureService(secret);
    const seed = makeSeed();
    const sig1 = await svc.sign(seed);
    const sig2 = await svc.sign(seed);
    expect(sig1).toBe(sig2);
  });
});

// SEC-001 (Plan46 W0) — replay protection via monotonic nonce counter.
describe("SeedSignatureServiceImpl — SEC-001 nonce counter", () => {
  it("accepts strictly increasing nonces for the same agent", () => {
    const svc = new SeedSignatureServiceImpl();
    expect(svc.verifyNonce("agent-a", 1)).toBe(true);
    expect(svc.verifyNonce("agent-a", 2)).toBe(true);
    expect(svc.verifyNonce("agent-a", 5)).toBe(true);
  });

  it("rejects duplicate nonce (replay attack)", () => {
    const svc = new SeedSignatureServiceImpl();
    expect(svc.verifyNonce("agent-a", 42)).toBe(true);
    expect(svc.verifyNonce("agent-a", 42)).toBe(false);
  });

  it("rejects nonce below last seen (reorder/replay)", () => {
    const svc = new SeedSignatureServiceImpl();
    svc.verifyNonce("agent-a", 100);
    expect(svc.verifyNonce("agent-a", 50)).toBe(false);
    expect(svc.verifyNonce("agent-a", 99)).toBe(false);
  });

  it("tracks nonces per agentId independently", () => {
    const svc = new SeedSignatureServiceImpl();
    svc.verifyNonce("agent-a", 10);
    svc.verifyNonce("agent-b", 3);
    expect(svc.verifyNonce("agent-b", 4)).toBe(true);
    expect(svc.verifyNonce("agent-b", 3)).toBe(false);
    expect(svc.verifyNonce("agent-a", 11)).toBe(true);
  });

  it("rejects non-finite nonces", () => {
    const svc = new SeedSignatureServiceImpl();
    expect(svc.verifyNonce("agent-a", Number.NaN)).toBe(false);
    expect(svc.verifyNonce("agent-a", Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("clear() resets nonce map (replay rejection no longer applies after clear)", () => {
    const svc = new SeedSignatureServiceImpl();
    svc.verifyNonce("agent-a", 10);
    expect(svc.verifyNonce("agent-a", 10)).toBe(false);
    svc.clear();
    expect(svc.verifyNonce("agent-a", 10)).toBe(true);
  });

  it("getLastNonce returns undefined before first nonce and value after", () => {
    const svc = new SeedSignatureServiceImpl();
    expect(svc.getLastNonce("agent-a")).toBeUndefined();
    svc.verifyNonce("agent-a", 7);
    expect(svc.getLastNonce("agent-a")).toBe(7);
  });
});
