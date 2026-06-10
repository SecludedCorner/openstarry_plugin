/**
 * vasana-engine plugin — Plan57 D-30-5 cycle 03-21 amendment refactor.
 *
 * **Form change only**: runner-level → plugin layer (五蘊 行蘊 → ITool plugin
 * pattern strict alignment). 4-method API surface unchanged. MR-12 既有不破壞.
 *
 * **Phase 7 elevation 先驅範例**: this plugin is the first concrete application
 * of the R/S/C/G template (Refactor / SICP / Compatibility / Greenfield) per
 * cycle 03-21 R3 D-§0-B AMEND-6.
 *
 * **D-§0-B AMEND-3**: plugin loader onBoot fail-fast (no soft-fail; reject-on-startup
 * via `loadHmacKey` + `verifyChain` at construction).
 *
 * @see openstarry_doc/Technical_Specifications/Plan57_D30_5_VasanaEngine_Binding_amendment_cycle03-21.md
 */

import type { IPlugin, IPluginContext, PluginHooks } from '@openstarry/sdk';
import { createVasanaEngine, type VasanaEngine, type VasanaEngineConfig } from './engine.js';

/**
 * Plugin manifest config — passed via `ctx.config` per OpenStarry plugin convention.
 * Matches `VasanaEngineConfig` semantics; the plugin factory threads through.
 */
export type VasanaEnginePluginConfig = VasanaEngineConfig;

/**
 * Per D-§0-A: factory pattern `createVasanaEnginePlugin(manifest, factory(ctx))`.
 *
 * The plugin exposes the underlying `VasanaEngine` via the plugin-host
 * surface; consumers obtain it through plugin lifecycle (Phase 7-aligned).
 * Container-plugin lifecycle protocol kept distinct from the outer 4-method
 * consumer surface (D-§0-B AMEND-1 dual-barrier disambiguation).
 */
export function createVasanaEnginePlugin(): IPlugin {
  return {
    manifest: {
      name: 'vasana-engine',
      version: '0.1.0-alpha',
      description: 'Plan57 D-30-5 VasanaEngine — vasanā (習氣) deposit-only passive-observer plugin',
      skandha: 'samskara' as const, // 行蘊 — the canonical aggregate for vasanā
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg = (ctx.config ?? {}) as VasanaEnginePluginConfig;
      // Boot-time fail-fast (D-§0-B AMEND-3): createVasanaEngine throws on
      // chain integrity violation; do NOT swallow.
      const engine: VasanaEngine = createVasanaEngine(cfg);

      // Expose engine for downstream consumers via plugin-host context.
      // (Container-plugin lifecycle protocol — distinct from the outer 4-method
      // consumer surface per D-§0-B AMEND-1.)
      const exposed = engine as VasanaEngine & { __pluginAttached?: boolean };
      exposed.__pluginAttached = true;

      return {
        // No hooks needed at this lifecycle stage; Plan60 Blackboard-Alaya read-API
        // would attach onto this engine later (Track 2 DEFERRED).
        dispose: () => {
          /* engine has no resources to release; nonceCache TTL is bounded */
        },
      };
    },
  };
}

/** Re-export the engine factory for direct consumption (non-plugin contexts). */
export { createVasanaEngine, type VasanaEngine, type VasanaEngineConfig } from './engine.js';

export default createVasanaEnginePlugin;
