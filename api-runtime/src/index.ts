/**
 * @openstarry-plugin/api-runtime — Plan59 Phase 6 第六棒 plugin factory.
 *
 * **Plugin form upfront (G-only instance per Plan59 §2)**: 識蘊 (Vijnana;
 * 「了別」 discriminating awareness) translated to runtime observability
 * (read-only `observe`) + bounded intervention (mutating `invoke` with
 * HMAC + 6th replay-cache contributor `apr:`).
 *
 * Six-plugin replay-cache topology:
 *   `psh:` (Plan52) + `ac9:` (Plan54) + `mvq:` (Plan56) +
 *   `vsn:` (Plan57 plugin form) + `msh:` (Plan58) + **`apr:` (Plan59)**.
 *
 * @see openstarry_doc/Technical_Specifications/Plan59_API_Runtime_Binding.md
 */

import type { IPlugin, IPluginContext, PluginHooks } from '@openstarry/sdk';
import { createApiRuntime, type ApiRuntimeConfig, type IRuntime } from './runtime.js';

export type ApiRuntimePluginConfig = ApiRuntimeConfig;

export function createApiRuntimePlugin(): IPlugin {
  return {
    manifest: {
      name: 'api-runtime',
      version: '0.1.0-alpha',
      description: 'Plan59 API Runtime — observability + bounded intervention (Phase 6 第六棒; 識蘊 Vijnana)',
      // 識蘊 — discriminating awareness / introspection.
      skandha: 'vijnana' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg = (ctx.config ?? {}) as unknown as ApiRuntimePluginConfig;
      // Boot-time fail-fast inside createApiRuntime → loadHmacKey.
      const runtime: IRuntime = createApiRuntime(cfg);
      const exposed = runtime as IRuntime & { __pluginAttached?: boolean };
      exposed.__pluginAttached = true;

      return {
        dispose: () => {
          /* runtime is single-process; nonceCache TTL bounds release */
        },
      };
    },
  };
}

export { createApiRuntime, type ApiRuntimeConfig, type IRuntime } from './runtime.js';
export { buildCanonical, loadHmacKey, type InvokeFn, type InvokeFactoryArgs } from './invoke.js';
export { createObserve, type ObserveFn } from './observe.js';
export { PluginStateRegistry, newRecord, type PluginRuntimeRecord } from './state.js';

export default createApiRuntimePlugin;
