/**
 * api-runtime / observe — read-only introspection path.
 *
 * **Plan59 §6.1 file-level separation (R3 D-§1-R2-D 23/0)**: this module
 * contains the read-only path. Idempotent semantic; **no replay cache
 * attestation needed** (no mutation surface; `apr:` prefix attestation
 * lives entirely in `invoke.ts`).
 *
 * **Boundary invariant per Plan59 §6.2 (R3 D-§1-R2-E 23/0)**: the returned
 * `ApiRuntimeObserveResult` schema carries ONLY plugin-runtime fields
 * (plugin_id / log_level / debug_flag / soft_tracing / replay_cache_size).
 * The pushInput envelope's agent-identity, signature, nonce, and
 * capability-set fields are entirely absent. KERNEL R2 sub-check #7
 * set-disjointness PASS by static analysis of this file's exports.
 */

import {
  ApiRuntimeObserveResultSchema,
  ApiRuntimeObserveScopeSchema,
  type ApiRuntimeObserveResult,
  type ApiRuntimeObserveScope,
  type PluginRuntimeStateView,
} from '@openstarry/sdk';
import type { PluginStateRegistry } from './state.js';

/** Function shape returned to plugin consumers; signature has zero ε-surface envelope fields. */
export type ObserveFn = (raw: unknown) => ApiRuntimeObserveResult;

/**
 * Build the observe function bound to a registry + replay-cache size resolver.
 * The size resolver returns the current cache size (Plan59 §6.1: read-only
 * stats only — no nonces leaked).
 */
export function createObserve(args: {
  readonly registry: PluginStateRegistry;
  readonly replayCacheSize: () => number;
}): ObserveFn {
  return function observe(raw: unknown): ApiRuntimeObserveResult {
    const parsed = ApiRuntimeObserveScopeSchema.safeParse(raw ?? {});
    const scope: ApiRuntimeObserveScope = parsed.success ? parsed.data : {};

    const ids = scope.target_plugin
      ? args.registry.has(scope.target_plugin) ? [scope.target_plugin] : []
      : args.registry.ids();

    const replay_cache_size = args.replayCacheSize();
    const plugins: PluginRuntimeStateView[] = [];
    for (const plugin_id of ids) {
      const snap = args.registry.snapshot(plugin_id);
      if (!snap) continue;
      plugins.push({
        plugin_id,
        log_level: snap.log_level,
        debug_flag: snap.debug_flag,
        soft_tracing: snap.soft_tracing,
        replay_cache_size,
      });
    }
    return ApiRuntimeObserveResultSchema.parse({ plugins });
  };
}
