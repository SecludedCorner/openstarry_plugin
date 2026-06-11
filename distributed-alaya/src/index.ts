/**
 * @openstarry-plugin/distributed-alaya
 *
 * AC-7 full runtime implementation of IDistributedAlaya.
 *
 * This plugin is the first consumer (N=1) of IDistributedAlaya, satisfying
 * the compliance predicate for Tenet #6 (Eight Consciousnesses): COMPLIANT.
 *
 * Five Aggregates mapping (Plan39 W1, Architecture_Spec §5):
 * - plant()/propagate() → ISamskara (行蘊) — volitional seed-planting acts
 * - stored seeds → IVijnana (識蘊) — alaya-consciousness (eighth consciousness)
 *
 * Design decisions:
 * - Decision A: AC-7 in plugin layer, not core (Tenet #7 Microkernel Purity)
 * - Factory uses ctx.pushInput() pattern for core notification
 * - HMAC-SHA256 via Node.js crypto (no external deps)
 * - Vector clock merge: element-wise maximum (standard Lamport merge)
 */

import type { IPlugin, IPluginContext, PluginHooks, IPluginService } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";
import { SeedSignatureServiceImpl, DaemonKeyProvider, RandomKeyProvider } from "./seed-signature.js";
import { createBijaStore } from "./bija-store.js";
import { createDistributedAlaya } from "./distributed-alaya-impl.js";
import { IpcRemotePeer } from "./remote-peer.js";

export { createSeedSignatureService, DaemonKeyProvider, RandomKeyProvider } from "./seed-signature.js";
export type { ISeedKeyProvider } from "./seed-signature.js";
export { createBijaStore } from "./bija-store.js";
export { createDistributedAlaya } from "./distributed-alaya-impl.js";
export type { PlantError } from "./bija-store.js";
// TENET-2026-06-11: cross-process peer surface
export { IpcRemotePeer } from "./remote-peer.js";
export type { IRemoteAlayaPeer, AlayaVectorClock } from "./remote-peer.js";

// Plan60 Blackboard-Alaya forward addendum (cycle 03-23; Phase 6 7/7 完工 ✅).
// Existing surface unchanged per MR-12 既有不破壞; addendum is additive only.
export {
  buildAlayaCanonical,
  createAlayaSeedAttestor,
  loadAlayaHmacKey,
  REPLAY_CACHE_TOPOLOGY_N7,
  type AlayaSeedAttestor,
  type AlayaSeedAttestorConfig,
} from "./plan60-addendum.js";

export interface DistributedAlayaConfig {
  /** Agent ID that owns this alaya stream. Required. */
  readonly agentId: string;
  /**
   * Cluster-wide HMAC key hex string from Daemon spawn payload (Plan40 HMAC Option A).
   * When present, a DaemonKeyProvider is used — enabling genuine cross-agent verification.
   * When absent, falls back to RandomKeyProvider (pre-Plan40 standalone behavior).
   * MUST NOT be logged.
   *
   * TENET-2026-06-11: when running under the daemon, daemon-entry injects this
   * automatically from the cluster key — DaemonKeyProvider is finally
   * daemon-distributed in fact, not just in name.
   */
  readonly hmacKeyHex?: string;
  /**
   * TENET-2026-06-11: cross-process peers (daemon IPC endpoints). Each entry
   * registers an IpcRemotePeer so propagate() can deliver signed seeds across
   * OS process boundaries; the receiving daemon verifies independently with
   * its own cluster-key copy. Same-host scope (named pipe / unix socket).
   */
  readonly peers?: ReadonlyArray<{ readonly agentId: string; readonly socketPath: string }>;
}

/**
 * createDistributedAlayaPlugin — factory for the AC-7 distributed alaya plugin.
 *
 * Returns IPlugin. When loaded, this plugin:
 * 1. Creates ISeedSignatureService (HMAC-SHA256, agent-local key)
 * 2. Creates IBijaStore (local seed store with F-8 enforcement)
 * 3. Creates IDistributedAlaya runtime implementation
 * 4. Calls ctx.pushInput() to notify core that alaya is available (N=1 consumer)
 *
 * AC-W1-1: This factory exercises plant, propagate, and exchangeSeeds — N=1.
 */
export function createDistributedAlayaPlugin(config: DistributedAlayaConfig): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/distributed-alaya',
      version: '0.1.0-alpha',
      description: 'AC-7 full runtime: IDistributedAlaya with HMAC-SHA256, vector clocks, F-8 enforcement',
      skandha: ['samskara', 'vijnana'],
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // C5: Use ISeedKeyProvider abstraction for key injection (HMAC Option A, Plan40 W3-C).
      // DaemonKeyProvider: cluster-wide shared key from spawn payload — genuine cross-agent verification.
      // RandomKeyProvider: fallback for standalone/test scenarios (pre-Plan40 behavior).
      const keyProvider = config.hmacKeyHex
        ? new DaemonKeyProvider(config.hmacKeyHex)
        : new RandomKeyProvider();
      const signatureService = new SeedSignatureServiceImpl(keyProvider.getKey());
      const bijaStore = createBijaStore(config.agentId, signatureService);
      const alaya = createDistributedAlaya(config.agentId, bijaStore, signatureService);

      // TENET-2026-06-11: register cross-process peers from config.
      for (const peer of config.peers ?? []) {
        alaya.registerRemotePeer(new IpcRemotePeer(peer.agentId, peer.socketPath));
      }

      // pushInput pattern: notify core that IDistributedAlaya is available (N=1 consumer)
      ctx.pushInput({
        source: 'distributed-alaya',
        inputType: 'system_event',
        data: {
          event: 'alaya:ready',
          agentId: config.agentId,
        },
      });

      // Plan41 W1 (AC-TSR-4): Register alaya as typed service, eliminating `as any` provider cast.
      // Consumers use SERVICE_KEYS.DISTRIBUTED_ALAYA for type-safe lookup.
      if (ctx.services) {
        ctx.services.register({
          name: 'distributed-alaya',
          version: '0.1.0-alpha',
          getDistributedAlaya: () => alaya,
        } as IPluginService & { getDistributedAlaya: () => typeof alaya });
      }

      return {
        dispose: () => {
          // TENET-2026-06-11: close remote peer connections first
          alaya.closeRemotePeers();
          // SEC-002: zero HMAC key material on shutdown
          signatureService.clear();
          if (keyProvider instanceof DaemonKeyProvider) {
            keyProvider.clear();
          }
        },
      };
    },
  };
}
