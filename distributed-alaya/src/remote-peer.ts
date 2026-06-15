/**
 * remote-peer — cross-process alaya peer over daemon IPC (TENET-2026-06-11).
 *
 * Until this file, "distributed" alaya peers were raw in-process object
 * references (PropagationTarget) — the admitted shim. IpcRemotePeer makes a
 * peer a REAL remote: it speaks the daemon's line-delimited JSON-RPC over
 * the peer agent's named pipe (Windows) / unix socket, calling the
 * `alaya.acceptSeed` RPC that the receiving daemon routes to its own
 * DistributedAlayaImpl.acceptRemote() — where the seed is INDEPENDENTLY
 * HMAC-verified with the receiver's copy of the daemon-distributed cluster
 * key before entering the store.
 *
 * Deliberately implemented over node:net directly (~60 LOC of framing)
 * rather than importing apps/runner's IPC client: the plugin's only
 * workspace dependency is @openstarry/sdk, and a plugin→runner import would
 * be a layering violation. Wire format (one JSON object per line) is the
 * daemon's stable contract.
 *
 * Honest scope: same-host transport (named pipe / UDS), trusted-parent key
 * distribution. Replay defense added 2026-06-15 (Spec Addendum: ISeed gains an
 * optional `nonce`; the receiver's acceptRemote rejects a replayed/reordered
 * seed via the signature service's per-agent monotonic verifyNonce). Still
 * out of scope: cross-host transport, N>2 gossip, late-joiner snapshot exchange.
 */

import { createConnection, type Socket } from "node:net";
import type { ISeed } from "@openstarry/sdk";

/** Vector clock shape (mirrors SDK type — Readonly<Record<string, number>>). */
export type AlayaVectorClock = Readonly<Record<string, number>>;

export interface IRemoteAlayaPeer {
  readonly agentId: string;
  /** Deliver a signed seed + clock to the remote peer; rejects on RPC error. */
  deliver(seed: ISeed, vectorClock: AlayaVectorClock, fromAgentId: string): Promise<void>;
  /** Close the underlying connection (idempotent). */
  close(): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Line-delimited JSON-RPC client over a daemon IPC socket.
 * Lazy-connects on first deliver(); reconnects after a dropped connection.
 */
export class IpcRemotePeer implements IRemoteAlayaPeer {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();

  constructor(
    public readonly agentId: string,
    private readonly socketPath: string,
    private readonly rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

  async deliver(seed: ISeed, vectorClock: AlayaVectorClock, fromAgentId: string): Promise<void> {
    await this.call("alaya.acceptSeed", { seed, vectorClock, fromAgentId });
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.failAllPending(new Error(`alaya remote peer "${this.agentId}": connection closed`));
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;

    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding("utf-8");

      const onError = (err: Error): void => {
        socket.destroy();
        reject(new Error(`alaya remote peer "${this.agentId}": connect failed — ${err.message}`));
      };
      socket.once("error", onError);

      socket.once("connect", () => {
        socket.off("error", onError);
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("error", () => {
          this.socket = null;
          this.failAllPending(new Error(`alaya remote peer "${this.agentId}": socket error`));
        });
        socket.on("close", () => {
          this.socket = null;
          this.failAllPending(new Error(`alaya remote peer "${this.agentId}": socket closed`));
        });
        this.socket = socket;
        resolve(socket);
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.onLine(line);
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // not for us (e.g. daemon event broadcast) — ignore
    }
    if (typeof msg.id !== "number") return; // notification/event — ignore
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`alaya remote peer "${this.agentId}": RPC error ${msg.error.code ?? "?"} — ${msg.error.message ?? "unknown"}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const socket = await this.ensureConnected();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`alaya remote peer "${this.agentId}": RPC timeout for ${method} after ${this.rpcTimeoutMs}ms`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}
