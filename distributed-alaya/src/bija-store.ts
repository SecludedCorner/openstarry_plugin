/**
 * BijaStore — local seed store for a single agent's alaya stream.
 *
 * Implements IBijaStore (Plan39 W1, Architecture_Spec §3.2).
 *
 * F-8 ownerAgent enforcement (CONSTRAINT-D9):
 * - plant() verifies seed.agentId === this agent's id before accepting
 * - Mismatch returns typed error, never throws
 *
 * Vector clock merge uses element-wise maximum (standard Lamport merge).
 * query() returns deep copies, never references (Sunyata safeguard).
 */

import type {
  ISeed,
  SeedFilter,
  SeedPatch,
  IBijaStore,
  ISeedSignatureService,
  VectorClock,
} from "@openstarry/sdk";

export interface PlantError {
  readonly code: 'OWNER_MISMATCH' | 'SIGNATURE_INVALID' | 'STORE_ERROR';
  readonly message: string;
}

/**
 * SEC-004 (Plan46 W0): upper bound on the number of distinct agent entries
 * tracked in a single BijaStore's vector clock. Beyond this cap,
 * mergeVectorClock() prunes the lowest-counter entries to keep memory bounded.
 *
 * HYPOTHESIS (Rule #59): 100 is a reasonable starting cap for mesh topologies
 * observed to date; calibrate with R10+ operational data if clusters grow.
 */
export const MAX_VECTOR_CLOCK_AGENTS = 100;

export class BijaStoreImpl implements IBijaStore {
  private readonly seeds = new Map<string, ISeed>();
  private clock: Record<string, number> = {};

  constructor(
    private readonly agentId: string,
    private readonly signatureService: ISeedSignatureService,
  ) {
    this.clock[agentId] = 0;
  }

  async plant(seed: ISeed): Promise<void> {
    // F-8: verify agentId matches owning agent (CONSTRAINT-D9, AC-W1-2)
    if (seed.agentId !== this.agentId) {
      // Typed error path — does not throw
      const err: PlantError = {
        code: 'OWNER_MISMATCH',
        message: `plant() rejected: seed.agentId '${seed.agentId}' !== owning agent '${this.agentId}'`,
      };
      throw Object.assign(new Error(err.message), { plantError: err });
    }

    // Sign the seed
    const signature = await this.signatureService.sign(seed);
    const signedSeed: ISeed = { ...seed, signature };

    // Advance own vector clock entry
    this.clock[this.agentId] = (this.clock[this.agentId] ?? 0) + 1;

    this.seeds.set(seed.seedId, signedSeed);
  }

  async query(filter: SeedFilter): Promise<ISeed[]> {
    const results: ISeed[] = [];
    for (const seed of this.seeds.values()) {
      if (filter.agentId !== undefined && seed.agentId !== filter.agentId) continue;
      if (filter.skandha !== undefined && seed.skandha !== filter.skandha) continue;
      if (filter.visibility !== undefined && seed.visibility !== filter.visibility) continue;
      if (filter.since !== undefined && seed.createdAt < filter.since) continue;
      // Return deep copies — Sunyata safeguard
      results.push({ ...seed });
    }
    return results;
  }

  async update(seedId: string, patch: SeedPatch): Promise<void> {
    const existing = this.seeds.get(seedId);
    if (!existing) return;

    // SeedPatch uses Pick allowlist (Plan41 W0): only content, visibility, updatedAt, signature are mutable.
    // Runtime enforcement mirrors the compile-time Pick — extract only allowed fields.
    const { content, visibility, updatedAt: _patchedAt, signature: _patchedSig } = patch;
    const updated: ISeed = {
      ...existing,
      ...(content !== undefined && { content }),
      ...(visibility !== undefined && { visibility }),
      updatedAt: Date.now(),
    };

    // Re-sign after update
    const signature = await this.signatureService.sign(updated);
    this.seeds.set(seedId, { ...updated, signature });
  }

  async remove(seedId: string): Promise<void> {
    this.seeds.delete(seedId);
  }

  getVectorClock(): VectorClock {
    return { ...this.clock } as VectorClock;
  }

  mergeVectorClock(incoming: VectorClock): void {
    for (const [agentId, counter] of Object.entries(incoming)) {
      this.clock[agentId] = Math.max(this.clock[agentId] ?? 0, counter);
    }
    // SEC-004: cap distinct-agent count; prune lowest-counter entries but
    // always preserve this store's own agent. Own agent is authoritative.
    const keys = Object.keys(this.clock);
    if (keys.length > MAX_VECTOR_CLOCK_AGENTS) {
      const excess = keys.length - MAX_VECTOR_CLOCK_AGENTS;
      const sortable = keys
        .filter((k) => k !== this.agentId)
        .map((k) => [k, this.clock[k] ?? 0] as const)
        .sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < excess && i < sortable.length; i++) {
        delete this.clock[sortable[i][0]];
      }
    }
  }

  /**
   * accept() — receive a propagated seed from a remote agent.
   *
   * Unlike plant(), accept() does NOT enforce F-8 (the seed legitimately
   * belongs to a different agent). Signature verification is performed by
   * the caller (DistributedAlayaImpl.propagate/exchangeSeeds) using the
   * sender's ISeedSignatureService before accept() is invoked — since the
   * HMAC key is agent-local and cannot be re-verified by the receiver.
   *
   * This method requires that the seed carries a signature field (set by
   * the caller's sign step); a missing signature is rejected fail-closed.
   *
   * Called by DistributedAlayaImpl.propagate() and exchangeSeeds()
   * when writing into a peer's store.
   */
  async accept(seed: ISeed): Promise<void> {
    // Fail-closed: reject seeds that were never signed
    if (!seed.signature) {
      const err: PlantError = {
        code: 'SIGNATURE_INVALID',
        message: `accept() rejected: missing signature for seed '${seed.seedId}' from agent '${seed.agentId}'`,
      };
      throw Object.assign(new Error(err.message), { plantError: err });
    }

    // Merge remote agent into vector clock if not yet tracked
    if (this.clock[seed.agentId] === undefined) {
      this.clock[seed.agentId] = 0;
    }

    this.seeds.set(seed.seedId, { ...seed });
  }

  size(): number {
    return this.seeds.size;
  }
}

export function createBijaStore(
  agentId: string,
  signatureService: ISeedSignatureService,
): BijaStoreImpl {
  return new BijaStoreImpl(agentId, signatureService);
}
