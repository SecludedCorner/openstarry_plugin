/**
 * api-runtime / runtime — `IRuntime` composition surface.
 *
 * Combines the read-only `observe` (no replay) and the bounded mutating
 * `invoke` (HMAC + `apr:` replay) into a single object. Per Plan59 §6.2
 * boundary invariant, NEITHER method's signature references the
 * agent-identity / capability-set fields owned by the pushInput envelope —
 * verifiable by static-analysis grep over this file (KERNEL R2 sub-check
 * #7 set-disjointness predicate decidable Yes/No).
 */

import { NonceCache } from '@openstarry/sdk';
import { createInvoke, loadHmacKey, type InvokeFn } from './invoke.js';
import { createObserve, type ObserveFn } from './observe.js';
import { PluginStateRegistry } from './state.js';

/**
 * Public surface of the API Runtime — Plan59 識蘊 (Vijnana) two-path model:
 * `observe` for 觀察 (read-only introspection); `invoke` for 介入 (bounded
 * intervention). Plus boot-time accessors needed by the plugin host
 * (manifest integrity audit; replay cache size for forensic).
 */
export interface IRuntime {
  observe: ObserveFn;
  invoke: InvokeFn;
  /** Registry helper — exposed for the plugin host's plugin-mount sequence. */
  register(plugin_id: string): void;
  /** Replay cache size accessor — used by `observe` and forensic audit. */
  readonly replayCacheSize: () => number;
}

export interface ApiRuntimeConfig {
  /** Hex-encoded HMAC key (≥ 32 bytes). MUST come from CSPRNG. */
  readonly hmacKeyHex?: string;
  /** Optional shared nonce cache (6-contributor opt-in). */
  readonly sharedNonceCache?: NonceCache;
  /** Replay cache TTL (default 24h). */
  readonly nonceTtlMs?: number;
  /** Key-rotation overlap window (default 24h). */
  readonly rotationOverlapMs?: number;
  /** Optional pre-registered plugin ids. */
  readonly initialPlugins?: readonly string[];
}

/**
 * Build a runtime instance — applies boot-time fail-fast (HMAC key
 * provenance + length checks; default ttl/rotation invariants).
 */
export function createApiRuntime(cfg: ApiRuntimeConfig = {}): IRuntime {
  const hmacKey = loadHmacKey(cfg.hmacKeyHex);
  const ttl = cfg.nonceTtlMs ?? 24 * 60 * 60 * 1000;
  const rotation = cfg.rotationOverlapMs ?? 24 * 60 * 60 * 1000;
  const nonceCache = cfg.sharedNonceCache ?? new NonceCache(ttl, rotation);
  const registry = new PluginStateRegistry();

  for (const id of cfg.initialPlugins ?? []) {
    registry.register(id);
  }

  const replayCacheSize = (): number => nonceCache.size;
  const observe = createObserve({ registry, replayCacheSize });
  const invoke = createInvoke({ registry, hmacKey, nonceCache });

  return {
    observe,
    invoke,
    register: (plugin_id: string) => registry.register(plugin_id),
    replayCacheSize,
  };
}
