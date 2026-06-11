/**
 * mesh — Plan58 Mesh plugin (cycle 03-21 v0.55.0-alpha).
 *
 * Phase 6 第五棒 — Option B Centralized Hub broker; in-process publisher-subscriber;
 * routing-table compiled at boot from plugin manifests; cycle detection via
 * Kahn's topological sort. Plan52/54/56/57/58 isomorph; ε-surface 0-delta.
 *
 * @see openstarry_doc/Technical_Specifications/Plan58_Mesh_Binding.md
 */

export {
  compileRoutingTable,
  computeManifestIntegrityHash,
  type PluginManifestEntry,
  type RoutingTable,
} from './routing.js';

export {
  createMeshBroker,
  type MeshBroker,
  type MeshBrokerConfig,
  type MeshDeliveryHandler,
} from './broker.js';

export {
  createMeshPlugin,
  type MeshPluginConfig,
} from './plugin.js';

export { default } from './plugin.js';
