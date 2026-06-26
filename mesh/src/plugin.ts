/**
 * mesh plugin — Plan58 Phase 6 第五棒 plugin factory.
 *
 * @see openstarry_doc/Technical_Specifications/Plan58_Mesh_Binding.md
 */

import type { IPlugin, IPluginContext, PluginHooks } from '@openstarry/sdk';
import { createMeshBroker, type MeshBrokerConfig } from './broker.js';

export type MeshPluginConfig = MeshBrokerConfig;

export function createMeshPlugin(): IPlugin {
  return {
    manifest: {
      name: 'mesh',
      version: '0.1.0-alpha',
      description: 'Plan58 Mesh — distributed agent communication via centralized hub (Phase 6 第五棒)',
      skandha: 'rupa' as const, // 色蘊 — communication channel substrate
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // FIX-2026-06-11: the factory previously passed ctx.config straight into
      // createMeshBroker, but MeshBrokerConfig requires `manifests` and
      // `delivery` — so loading this plugin from a JSON agent config crashed
      // with "Cannot read properties of undefined (reading 'map')". The
      // plugin was undeliverable via config from day one (caught by the
      // phase6-agent.json example-config smoke boot). Defaults: empty routing
      // table + no-op delivery; programmatic embedders still pass real values.
      const raw = (ctx.config ?? {}) as Partial<MeshPluginConfig>;
      const cfg: MeshPluginConfig = {
        ...raw,
        manifests: raw.manifests ?? [],
        delivery: raw.delivery ?? (() => { /* no delivery sink wired — standalone boot */ }),
      };
      // Boot-time fail-fast: cycle detection + manifest integrity at construction.
      // No agent-facing hook is registered — the value of this package is the
      // exported MeshBroker API (library-as-wrapper; see openstarry_doc
      // Implementation_Reference/plugins.md honest note).
      createMeshBroker(cfg);

      return {
        dispose: () => {
          /* broker is single-process; nonceCache TTL bounds release */
        },
      };
    },
  };
}

export { createMeshBroker, type MeshBroker, type MeshBrokerConfig } from './broker.js';

export default createMeshPlugin;
