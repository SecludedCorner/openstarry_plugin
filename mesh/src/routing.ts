/**
 * mesh / routing — Plan58 §2.3 routing-rule schema + boot-time compile.
 *
 * **D-§1-R2-A clarifications a+b+c**:
 *   a. Source plugin manifest declares `mesh_routes: [{topic, target_plugins[]}]`
 *   b. Mesh broker compiles routing-table at boot
 *   c. Cycle detection via Kahn's topological sort (D-§1-R2-B)
 *
 * **D-§1-R2-D**: SHA-256 manifest integrity attestation per Plan58 §2.4
 * 7-verification baseline (extends Plan57's 6).
 *
 * @see openstarry_doc/Technical_Specifications/Plan58_Mesh_Binding.md §2.3 + §2.4
 */

import { createHash } from 'node:crypto';
import { type MeshRoutingRule, MeshRoutingRuleSchema } from '@openstarry/sdk';

/** Compiled routing table — topic → set of target plugins (deduped). */
export type RoutingTable = Map<string, Set<string>>;

/** Plugin-level manifest entry as fed to the broker at boot. */
export interface PluginManifestEntry {
  /** Plugin identifier (must match `target_plugins[]` references). */
  readonly plugin_id: string;
  /** Mesh routes declared by this plugin (empty array allowed). */
  readonly mesh_routes: readonly MeshRoutingRule[];
}

/**
 * Compile routing table from plugin manifests.
 *
 * Per §2.4 manifest integrity: caller computes SHA-256 hash of canonical
 * manifest serialization separately; this function focuses on routing-rule
 * validation + cycle detection.
 *
 * Throws on schema violation, unresolved target_plugins, or cycle detection.
 */
export function compileRoutingTable(
  manifests: readonly PluginManifestEntry[],
): RoutingTable {
  const known_plugins = new Set(manifests.map((m) => m.plugin_id));
  const table: RoutingTable = new Map();

  for (const m of manifests) {
    for (const raw of m.mesh_routes) {
      const parsed = MeshRoutingRuleSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `mesh.routing: invalid routing rule from plugin ${m.plugin_id}: ${parsed.error.message}`,
        );
      }
      const rule = parsed.data;
      // Verify all target plugins exist.
      for (const tgt of rule.target_plugins) {
        if (!known_plugins.has(tgt)) {
          throw new Error(
            `mesh.routing: unresolved target plugin "${tgt}" in route from ${m.plugin_id} (topic "${rule.topic}")`,
          );
        }
      }
      const set = table.get(rule.topic) ?? new Set<string>();
      for (const tgt of rule.target_plugins) set.add(tgt);
      table.set(rule.topic, set);
    }
  }

  // Cycle detection via Kahn's topological sort (D-§1-R2-B).
  // Build a plugin-to-plugin dependency graph: plugin A → plugin B if A
  // publishes a topic that B is subscribed to.
  const graph: Map<string, Set<string>> = new Map();
  const in_degree: Map<string, number> = new Map();
  for (const p of known_plugins) {
    graph.set(p, new Set());
    in_degree.set(p, 0);
  }
  for (const m of manifests) {
    for (const rule of m.mesh_routes) {
      for (const tgt of rule.target_plugins) {
        if (m.plugin_id === tgt) {
          throw new Error(`mesh.routing: self-cycle detected — plugin ${m.plugin_id} routes to itself on topic "${rule.topic}"`);
        }
        graph.get(m.plugin_id)!.add(tgt);
      }
    }
  }
  for (const [, edges] of graph) {
    for (const tgt of edges) in_degree.set(tgt, (in_degree.get(tgt) ?? 0) + 1);
  }

  // Kahn's algorithm.
  const queue: string[] = [];
  for (const [p, d] of in_degree) {
    if (d === 0) queue.push(p);
  }
  let visited = 0;
  while (queue.length > 0) {
    const p = queue.shift()!;
    visited++;
    for (const tgt of graph.get(p) ?? []) {
      const d = (in_degree.get(tgt) ?? 0) - 1;
      in_degree.set(tgt, d);
      if (d === 0) queue.push(tgt);
    }
  }
  if (visited !== known_plugins.size) {
    throw new Error(
      `mesh.routing: cycle detected in routing graph (visited=${visited}, plugins=${known_plugins.size})`,
    );
  }

  return table;
}

/**
 * Compute SHA-256 hash of canonical manifest serialization (D-§1-R2-D + Plan58 §2.4 verification 7).
 *
 * Canonical form: sorted plugin_ids; sorted mesh_routes per plugin (by topic).
 */
export function computeManifestIntegrityHash(
  manifests: readonly PluginManifestEntry[],
): string {
  const canonical = JSON.stringify(
    [...manifests]
      .map((m) => ({
        plugin_id: m.plugin_id,
        mesh_routes: [...m.mesh_routes]
          .map((r) => ({ topic: r.topic, target_plugins: [...r.target_plugins].sort() }))
          .sort((a, b) => a.topic.localeCompare(b.topic)),
      }))
      .sort((a, b) => a.plugin_id.localeCompare(b.plugin_id)),
  );
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}
