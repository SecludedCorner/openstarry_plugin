/**
 * mesh plugin — Plan58 Phase 6 第五棒 plugin factory.
 *
 * @see openstarry_doc/Technical_Specifications/Plan58_Mesh_Binding.md
 */

import type { IPlugin, IPluginContext, PluginHooks } from '@openstarry/sdk';
import { createMeshBroker, type MeshBroker, type MeshBrokerConfig } from './broker.js';

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
      const cfg = (ctx.config ?? {}) as unknown as MeshPluginConfig;
      // Boot-time fail-fast: cycle detection + manifest integrity at construction.
      const broker: MeshBroker = createMeshBroker(cfg);
      const exposed = broker as MeshBroker & { __pluginAttached?: boolean };
      exposed.__pluginAttached = true;

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
