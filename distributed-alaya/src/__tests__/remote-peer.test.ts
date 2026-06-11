/**
 * IpcRemotePeer + acceptRemote unit tests (TENET-2026-06-11 — 宣言 #6).
 *
 * remote-peer framing is tested against an in-test net server speaking the
 * daemon's line-delimited JSON-RPC; acceptRemote is tested for genuine
 * (non-tautological) verification: same-key accepts, wrong-key rejects,
 * malformed rejects, vector clock merges.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ISeed } from "@openstarry/sdk";
import { IpcRemotePeer } from "../remote-peer.js";
import { SeedSignatureServiceImpl } from "../seed-signature.js";
import { createBijaStore } from "../bija-store.js";
import { createDistributedAlaya } from "../distributed-alaya-impl.js";

function testSocketPath(tag: string): string {
  const unique = `alaya-rp-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${unique}` : join(tmpdir(), `${unique}.sock`);
}

function makeSeed(agentId: string, overrides: Partial<ISeed> = {}): ISeed {
  const now = Date.now();
  return {
    seedId: `seed-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    skandha: "vijnana",
    content: { memo: "hello across the boundary" },
    visibility: "group",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const servers: Server[] = [];
const peers: IpcRemotePeer[] = [];
afterEach(() => {
  for (const p of peers.splice(0)) p.close();
  for (const s of servers.splice(0)) s.close();
});

describe("IpcRemotePeer framing", () => {
  it("frames alaya.acceptSeed as line-delimited JSON-RPC and resolves on result", async () => {
    const socketPath = testSocketPath("ok");
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        const msg = JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>;
        received.push(msg);
        socket.write(JSON.stringify({ id: msg.id, result: { accepted: true } }) + "\n");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(socketPath, r));

    const peer = new IpcRemotePeer("agent-b", socketPath);
    peers.push(peer);
    const seed = { ...makeSeed("agent-a"), signature: "feedface" };
    await peer.deliver(seed, { "agent-a": 1 }, "agent-a");

    expect(received.length).toBe(1);
    expect(received[0].method).toBe("alaya.acceptSeed");
    const params = received[0].params as { seed: ISeed; vectorClock: Record<string, number>; fromAgentId: string };
    expect(params.seed.seedId).toBe(seed.seedId);
    expect(params.vectorClock).toEqual({ "agent-a": 1 });
    expect(params.fromAgentId).toBe("agent-a");
  });

  it("rejects when the remote returns an RPC error", async () => {
    const socketPath = testSocketPath("err");
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        const msg = JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>;
        socket.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "HMAC verification failed" } }) + "\n");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(socketPath, r));

    const peer = new IpcRemotePeer("agent-b", socketPath);
    peers.push(peer);
    await expect(
      peer.deliver({ ...makeSeed("agent-a"), signature: "feedface" }, {}, "agent-a"),
    ).rejects.toThrow(/HMAC verification failed/);
  });

  it("times out when the remote never answers", async () => {
    const socketPath = testSocketPath("hang");
    const server = createServer(() => { /* accept and stay silent */ });
    servers.push(server);
    await new Promise<void>((r) => server.listen(socketPath, r));

    const peer = new IpcRemotePeer("agent-b", socketPath, 200);
    peers.push(peer);
    await expect(
      peer.deliver({ ...makeSeed("agent-a"), signature: "feedface" }, {}, "agent-a"),
    ).rejects.toThrow(/timeout/);
  });

  it("rejects cleanly when the endpoint does not exist", async () => {
    const peer = new IpcRemotePeer("agent-b", testSocketPath("absent"));
    peers.push(peer);
    await expect(
      peer.deliver({ ...makeSeed("agent-a"), signature: "feedface" }, {}, "agent-a"),
    ).rejects.toThrow(/connect failed/);
  });
});

describe("DistributedAlayaImpl.acceptRemote — genuine cross-boundary verification", () => {
  function makeNode(agentId: string, keyHex: string) {
    const signatureService = new SeedSignatureServiceImpl(Buffer.from(keyHex, "hex"));
    const store = createBijaStore(agentId, signatureService);
    const alaya = createDistributedAlaya(agentId, store, signatureService);
    return { alaya, store, signatureService };
  }

  it("accepts a seed signed with the SHARED cluster key and merges the clock", async () => {
    const keyHex = randomBytes(32).toString("hex");
    const sender = makeNode("agent-a", keyHex);
    const receiver = makeNode("agent-b", keyHex);

    const seed = makeSeed("agent-a");
    const signature = await sender.signatureService.sign(seed);

    await receiver.alaya.acceptRemote({ ...seed, signature }, { "agent-a": 3 });

    const seeds = await receiver.alaya.query({});
    expect(seeds.length).toBe(1);
    expect(seeds[0].seedId).toBe(seed.seedId);
    expect(seeds[0].agentId).toBe("agent-a"); // ownership preserved
    expect(receiver.store.getVectorClock()["agent-a"]).toBe(3);
  });

  it("REJECTS a seed signed with a DIFFERENT key (verification is genuine, not tautological)", async () => {
    const sender = makeNode("agent-a", randomBytes(32).toString("hex"));
    const receiver = makeNode("agent-b", randomBytes(32).toString("hex"));

    const seed = makeSeed("agent-a");
    const signature = await sender.signatureService.sign(seed);

    await expect(receiver.alaya.acceptRemote({ ...seed, signature }, { "agent-a": 1 }))
      .rejects.toThrow(/HMAC verification failed/);
    expect(await receiver.alaya.query({})).toEqual([]);
  });

  it("REJECTS tampered content (signature no longer matches)", async () => {
    const keyHex = randomBytes(32).toString("hex");
    const sender = makeNode("agent-a", keyHex);
    const receiver = makeNode("agent-b", keyHex);

    const seed = makeSeed("agent-a");
    const signature = await sender.signatureService.sign(seed);
    const tampered = { ...seed, content: { memo: "EVIL" }, signature };

    await expect(receiver.alaya.acceptRemote(tampered, {})).rejects.toThrow(/HMAC verification failed/);
    expect(await receiver.alaya.query({})).toEqual([]);
  });

  it("REJECTS malformed shapes fail-closed (missing signature / missing ids)", async () => {
    const receiver = makeNode("agent-b", randomBytes(32).toString("hex"));
    const seed = makeSeed("agent-a");

    await expect(receiver.alaya.acceptRemote(seed, {})).rejects.toThrow(/malformed/); // no signature
    await expect(
      receiver.alaya.acceptRemote({ ...seed, seedId: "", signature: "aa" }, {}),
    ).rejects.toThrow(/malformed/);
    expect(await receiver.alaya.query({})).toEqual([]);
  });

  it("propagate() routes to a registered remote peer when no in-process target matches", async () => {
    const keyHex = randomBytes(32).toString("hex");
    const sender = makeNode("agent-a", keyHex);

    const delivered: Array<{ seed: ISeed; clock: Record<string, number> }> = [];
    sender.alaya.registerRemotePeer({
      agentId: "agent-b",
      deliver: async (seed, vectorClock) => {
        delivered.push({ seed, clock: { ...vectorClock } });
      },
      close: () => { /* noop */ },
    });

    const seed = makeSeed("agent-a");
    await sender.alaya.plant(seed);
    await sender.alaya.propagate(seed.seedId, ["agent-b"]);

    expect(delivered.length).toBe(1);
    expect(delivered[0].seed.seedId).toBe(seed.seedId);
    expect(typeof delivered[0].seed.signature).toBe("string");
    expect(delivered[0].clock["agent-a"]).toBeGreaterThanOrEqual(1);
  });
});
