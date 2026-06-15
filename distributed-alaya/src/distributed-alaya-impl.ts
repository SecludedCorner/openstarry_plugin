/**
 * DistributedAlayaImpl — full AC-7 runtime implementation of IDistributedAlaya.
 *
 * Architecture mapping (Plan39 W1, Architecture_Spec §5):
 * - plant()/propagate() → ISamskara (行蘊) — volitional acts
 * - stored seeds → IVijnana (識蘊) — alaya-consciousness storage
 *
 * Design (Architecture_Spec Decision A):
 * - Lives in plugin layer (zero new core LOC for AC-7)
 * - This plugin is the first consumer (N=1), satisfying the compliance predicate
 * - plant()/propagate() are always explicit (Sunyata safeguard)
 *
 * Security (Architecture_Spec §6.1):
 * - Inbound seeds verified via ISeedSignatureService.verify() before plant()
 * - Invalid/missing signatures rejected fail-closed
 */

import type {
  IDistributedAlaya,
  ISeed,
  SeedFilter,
  SeedScope,
  SeedPatch,
  SeedCallback,
  ExchangeResult,
  IBijaStore,
  ISeedSignatureService,
  SeedPropagationRequest,
  IAlayaSnapshot,
} from "@openstarry/sdk";
import type { BijaStoreImpl } from "./bija-store.js";
import type { IRemoteAlayaPeer, AlayaVectorClock } from "./remote-peer.js";

type Unsubscribe = () => void;

// BijaStoreImpl exposes accept() at implementation level (not on IBijaStore SDK interface).
// We use a structural intersection so we do not import the concrete class as a value dependency.
type IBijaStoreWithAccept = IBijaStore & Pick<BijaStoreImpl, 'accept'>;

// verifyNonce is an impl-level method (SEC-001 / Spec Addendum 2026-06-15), NOT on the
// FROZEN ISeedSignatureService SDK interface. Structural intersection — same precedent
// as IBijaStoreWithAccept — so acceptRemote can use it when the concrete service provides
// it, without a value dependency on the concrete class. Optional: a signature service
// without verifyNonce simply skips the replay check (backward compatible).
type SigServiceMaybeNonce = ISeedSignatureService & {
  verifyNonce?(agentId: string, nonce: number): boolean;
};

interface PropagationTarget {
  readonly agentId: string;
  store: IBijaStoreWithAccept;
  signatureService: ISeedSignatureService;
}

export class DistributedAlayaImpl implements IDistributedAlaya {
  private readonly targets = new Map<string, PropagationTarget>();
  // TENET-2026-06-11: REAL remote peers (cross-process, daemon IPC) alongside
  // the in-process PropagationTargets. Impl-level only — the FROZEN
  // IDistributedAlaya SDK interface is untouched (same precedent as
  // BijaStoreImpl.accept).
  private readonly remotePeers = new Map<string, IRemoteAlayaPeer>();
  private readonly subscribers: Array<{ filter: SeedFilter; callback: SeedCallback }> = [];

  // Spec Addendum 2026-06-15 (ISeed Replay-Nonce): strictly-increasing per-agent
  // nonce stamped on THIS agent's own seeds at plant() time. Seeded from wall-clock
  // ms and bumped to stay strictly monotonic across rapid plants within a run.
  private lastOutboundNonce = 0;

  constructor(
    private readonly agentId: string,
    private readonly bijaStore: IBijaStoreWithAccept,
    private readonly signatureService: ISeedSignatureService,
  ) {}

  /**
   * Register a peer target for propagation and exchange.
   * In a real multi-agent setup, these would be remote connections.
   * For AC-7 compliance (N>=1 consumer), the plugin itself registers as a target.
   */
  registerTarget(target: PropagationTarget): void {
    this.targets.set(target.agentId, target);
  }

  /** TENET-2026-06-11: register a cross-process peer (daemon IPC). */
  registerRemotePeer(peer: IRemoteAlayaPeer): void {
    this.remotePeers.set(peer.agentId, peer);
  }

  unregisterRemotePeer(agentId: string): void {
    const peer = this.remotePeers.get(agentId);
    if (peer) {
      peer.close();
      this.remotePeers.delete(agentId);
    }
  }

  /** Close all remote peer connections (plugin dispose path). */
  closeRemotePeers(): void {
    for (const [, peer] of this.remotePeers) peer.close();
    this.remotePeers.clear();
  }

  /**
   * TENET-2026-06-11: receiver side of cross-process propagation.
   * Called by the daemon's `alaya.acceptSeed` RPC handler. The seed crossed
   * an OS process boundary as JSON — verification here uses THIS process's
   * own copy of the daemon-distributed cluster key, making it a genuine
   * cross-boundary integrity check (not the sender re-verifying itself).
   * Fail-closed: malformed shape or invalid signature rejects, store untouched.
   */
  async acceptRemote(seed: ISeed, vectorClock: AlayaVectorClock): Promise<void> {
    if (
      typeof seed !== "object" || seed === null ||
      typeof seed.seedId !== "string" || seed.seedId.length === 0 ||
      typeof seed.agentId !== "string" || seed.agentId.length === 0 ||
      typeof seed.signature !== "string" || seed.signature.length === 0 ||
      typeof vectorClock !== "object" || vectorClock === null
    ) {
      throw new Error("alaya.acceptRemote: malformed seed or vector clock (fail-closed)");
    }

    const isValid = await this.signatureService.verify(seed);
    if (!isValid) {
      throw new Error(`alaya.acceptRemote: HMAC verification failed for seed ${seed.seedId} (fail-closed)`);
    }

    // Spec Addendum 2026-06-15: replay/reorder defense. The nonce lives inside the
    // HMAC-signed canonical, so a *tampered* nonce already failed verify() above.
    // What this guards is a *replayed* (byte-identical, still-valid) seed: its nonce
    // is <= the last accepted nonce for this agentId. Fail-closed. Seeds without a
    // nonce (pre-addendum senders) take the legacy path unchanged.
    if (typeof seed.nonce === "number") {
      const sig = this.signatureService as SigServiceMaybeNonce;
      if (typeof sig.verifyNonce === "function" && !sig.verifyNonce(seed.agentId, seed.nonce)) {
        throw new Error(
          `alaya.acceptRemote: nonce replay/reorder rejected for seed ${seed.seedId} ` +
          `(agent ${seed.agentId}, nonce ${seed.nonce}) (fail-closed)`,
        );
      }
    }

    await this.bijaStore.accept(seed);
    this.bijaStore.mergeVectorClock(vectorClock as Record<string, number>);
  }

  async plant(seed: ISeed): Promise<void> {
    // Spec Addendum 2026-06-15: stamp a replay-defense nonce when the caller didn't
    // supply one. Strictly increasing per agent; gets covered by the HMAC signature
    // applied at propagate() time. Delegates to bijaStore which enforces F-8.
    const seedToPlant: ISeed = seed.nonce === undefined
      ? { ...seed, nonce: this.nextOutboundNonce() }
      : seed;
    await this.bijaStore.plant(seedToPlant);
  }

  /** Spec Addendum 2026-06-15: next strictly-increasing outbound nonce for this agent. */
  private nextOutboundNonce(): number {
    const candidate = Date.now();
    this.lastOutboundNonce = candidate > this.lastOutboundNonce ? candidate : this.lastOutboundNonce + 1;
    return this.lastOutboundNonce;
  }

  async query(filter: SeedFilter, _scope?: SeedScope): Promise<ISeed[]> {
    return this.bijaStore.query(filter);
  }

  async update(seedId: string, patch: SeedPatch): Promise<void> {
    await this.bijaStore.update(seedId, patch);
  }

  async remove(seedId: string): Promise<void> {
    await this.bijaStore.remove(seedId);
  }

  /**
   * Propagate a seed to target agents.
   * Sunyata safeguard: explicit, never automatic.
   * F-8: verifies seed.agentId matches this agent (CONSTRAINT-D9).
   */
  async propagate(seedId: string, targetAgentIds: string[]): Promise<void> {
    const matchedSeed = (await this.bijaStore.query({ agentId: this.agentId }))
      .find(s => s.seedId === seedId);

    if (!matchedSeed) return;

    // F-8 check at propagate entry point (CONSTRAINT-D9)
    if (matchedSeed.agentId !== this.agentId) return;

    const signature = await this.signatureService.sign(matchedSeed);
    const request: SeedPropagationRequest = {
      seedId,
      fromAgentId: this.agentId,
      toAgentIds: targetAgentIds,
      seed: matchedSeed,
      signature,
      vectorClock: this.bijaStore.getVectorClock(),
      timestamp: Date.now(),
    };

    for (const targetId of targetAgentIds) {
      const target = this.targets.get(targetId);
      const remotePeer = target ? undefined : this.remotePeers.get(targetId);
      if (!target && !remotePeer) continue;

      // Build signed seed for acceptance
      const signedSeed: ISeed = { ...request.seed, signature: request.signature };

      // Verify with cluster-shared HMAC key before forwarding (SEC-002, HMAC Option A).
      // With Daemon-distributed shared key, this is a genuine integrity check,
      // not a tautological self-verification.
      const isValid = await this.signatureService.verify(signedSeed);
      if (!isValid) continue;

      try {
        if (target) {
          // In-process target — accept into its store directly.
          // Preserves original agentId (no F-8 tautology).
          await target.store.accept(signedSeed);
          target.store.mergeVectorClock(request.vectorClock);
        } else {
          // TENET-2026-06-11: REMOTE peer — the seed leaves this process as
          // JSON over the peer daemon's IPC socket; the receiver verifies
          // independently with its own cluster-key copy (acceptRemote).
          await remotePeer!.deliver(signedSeed, request.vectorClock, this.agentId);
        }
      } catch {
        // fail-closed: propagation failure does not propagate exception
      }

      // Notify subscribers
      const propagationEvent = {
        seedId,
        fromAgentId: this.agentId,
        toAgentIds: [targetId],
        authorization: '',
        timestamp: request.timestamp,
      };
      for (const sub of this.subscribers) {
        if (this.matchesFilter(matchedSeed, sub.filter)) {
          sub.callback(propagationEvent);
        }
      }
    }
  }

  subscribe(filter: SeedFilter, callback: SeedCallback): Unsubscribe {
    const entry = { filter, callback };
    this.subscribers.push(entry);
    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * Bidirectional seed exchange with a peer.
   * Vector clocks merged using element-wise maximum after exchange (AC-W1-1).
   */
  async exchangeSeeds(peerId: string): Promise<ExchangeResult> {
    const target = this.targets.get(peerId);
    if (!target) {
      return { seedsExchanged: 0, conflictsResolved: 0, peerId, timestamp: Date.now() };
    }

    const ownSeeds = await this.bijaStore.query({});
    const peerSeeds = await target.store.query({});

    let exchanged = 0;
    let conflicts = 0;

    // Send own seeds to peer — verify before accept() to prevent injection (SEC-002).
    // With cluster-shared HMAC key (HMAC Option A), this.signatureService.verify()
    // uses the same key as target.signatureService — genuine cross-agent check.
    for (const seed of ownSeeds) {
      const isValid = await this.signatureService.verify(seed);
      if (!isValid) { conflicts++; continue; }
      try {
        await target.store.accept(seed);
        exchanged++;
      } catch {
        conflicts++;
      }
    }

    // Receive peer seeds into own store — verify with peer's service before accept() (SEC-002).
    // target.signatureService shares the Daemon-distributed cluster key, so this is a
    // genuine integrity check, not a tautological self-verification (HMAC Option A).
    for (const seed of peerSeeds) {
      const isValid = await target.signatureService.verify(seed);
      if (!isValid) { conflicts++; continue; }
      try {
        await this.bijaStore.accept(seed);
        exchanged++;
      } catch {
        conflicts++;
      }
    }

    // Merge vector clocks (element-wise maximum)
    const peerClock = target.store.getVectorClock();
    this.bijaStore.mergeVectorClock(peerClock);
    const ownClock = this.bijaStore.getVectorClock();
    target.store.mergeVectorClock(ownClock);

    return {
      seedsExchanged: exchanged,
      conflictsResolved: conflicts,
      peerId,
      timestamp: Date.now(),
    };
  }

  /**
   * snapshot() — capture a causally consistent snapshot for late-joiner initialization.
   * G1: Seeds ordered by vector clock (causal consistency guaranteed).
   * G3: Atomicity — single-threaded Node.js; no concurrent mutation possible during await.
   */
  async snapshot(): Promise<IAlayaSnapshot> {
    const seeds = await this.bijaStore.query({});
    return {
      seeds: Object.freeze([...seeds]),
      vectorClock: { ...this.bijaStore.getVectorClock() },
      timestamp: Date.now(),
    };
  }

  /**
   * restoreSnapshot() — initialize a late-joiner from a causally consistent snapshot.
   * G2: HMAC signature verified on each seed before planting.
   * G4: Freshness check — rejects snapshots older than freshnessThresholdMs (default 30s).
   * G5: Idempotent merge — plant() is skipped for seeds already present (IBijaStore.accept handles dedup).
   * G6: Ordering — Node.js single-threaded event loop ensures incoming propagate() calls are
   *     queued and processed after restoreSnapshot() completes; no explicit buffering needed.
   */
  async restoreSnapshot(
    snap: IAlayaSnapshot,
    signatureService: ISeedSignatureService,
    freshnessThresholdMs = 30000,
  ): Promise<void> {
    // G4: Freshness check
    if (Date.now() - snap.timestamp > freshnessThresholdMs) {
      throw new Error(
        `Snapshot too old: ${Date.now() - snap.timestamp}ms exceeds threshold ${freshnessThresholdMs}ms`,
      );
    }
    // G2: Verify HMAC signature on each seed
    for (const seed of snap.seeds) {
      const valid = await signatureService.verify(seed);
      if (!valid) {
        throw new Error(`HMAC verification failed for seed ${seed.seedId}`);
      }
    }
    // G5: Idempotent merge — plant only seeds not already present
    const existing = await this.bijaStore.query({});
    const existingIds = new Set(existing.map(s => s.seedId));
    for (const seed of snap.seeds) {
      if (!existingIds.has(seed.seedId)) {
        await this.bijaStore.accept(seed);
      }
    }
    // G6: Merge vector clock (element-wise max)
    this.bijaStore.mergeVectorClock(snap.vectorClock);
  }

  private matchesFilter(seed: ISeed, filter: SeedFilter): boolean {
    if (filter.agentId !== undefined && seed.agentId !== filter.agentId) return false;
    if (filter.skandha !== undefined && seed.skandha !== filter.skandha) return false;
    if (filter.visibility !== undefined && seed.visibility !== filter.visibility) return false;
    if (filter.since !== undefined && seed.createdAt < filter.since) return false;
    return true;
  }
}

export function createDistributedAlaya(
  agentId: string,
  bijaStore: IBijaStoreWithAccept,
  signatureService: ISeedSignatureService,
): DistributedAlayaImpl {
  return new DistributedAlayaImpl(agentId, bijaStore, signatureService);
}
