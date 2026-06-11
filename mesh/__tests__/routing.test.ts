/**
 * Plan58 §2.3 + §2.4 — routing-table compile + cycle detection tests.
 */

import { describe, expect, it } from 'vitest';
import {
  compileRoutingTable,
  computeManifestIntegrityHash,
  type PluginManifestEntry,
} from '../src/routing.js';

describe('Plan58 §2.3 — compileRoutingTable', () => {
  it('compiles routing table from valid manifests', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'pub-A', mesh_routes: [{ topic: 't1', target_plugins: ['sub-B', 'sub-C'] }] },
      { plugin_id: 'sub-B', mesh_routes: [] },
      { plugin_id: 'sub-C', mesh_routes: [] },
    ];
    const table = compileRoutingTable(manifests);
    expect(table.size).toBe(1);
    expect([...table.get('t1')!]).toEqual(expect.arrayContaining(['sub-B', 'sub-C']));
  });

  it('dedupes target_plugins across multiple manifests', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'pub-A', mesh_routes: [{ topic: 't1', target_plugins: ['sub-B'] }] },
      { plugin_id: 'pub-X', mesh_routes: [{ topic: 't1', target_plugins: ['sub-B'] }] },
      { plugin_id: 'sub-B', mesh_routes: [] },
    ];
    const table = compileRoutingTable(manifests);
    expect(table.get('t1')!.size).toBe(1);
  });

  it('rejects unresolved target plugins', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'pub-A', mesh_routes: [{ topic: 't1', target_plugins: ['ghost-plugin'] }] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/unresolved target plugin/);
  });

  it('rejects empty target_plugins array (Zod schema violation)', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'pub-A', mesh_routes: [{ topic: 't1', target_plugins: [] }] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/invalid routing rule/);
  });

  it('rejects empty topic (Zod schema violation)', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'pub-A', mesh_routes: [{ topic: '', target_plugins: ['sub-B'] }] },
      { plugin_id: 'sub-B', mesh_routes: [] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/invalid routing rule/);
  });

  it('detects self-cycle (plugin routes to itself)', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'self-A', mesh_routes: [{ topic: 't1', target_plugins: ['self-A'] }] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/self-cycle detected/);
  });

  it('detects 2-cycle via Kahn topological sort (D-§1-R2-B)', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [{ topic: 't1', target_plugins: ['B'] }] },
      { plugin_id: 'B', mesh_routes: [{ topic: 't2', target_plugins: ['A'] }] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/cycle detected in routing graph/);
  });

  it('detects 3-cycle (A → B → C → A)', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [{ topic: 't1', target_plugins: ['B'] }] },
      { plugin_id: 'B', mesh_routes: [{ topic: 't2', target_plugins: ['C'] }] },
      { plugin_id: 'C', mesh_routes: [{ topic: 't3', target_plugins: ['A'] }] },
    ];
    expect(() => compileRoutingTable(manifests)).toThrow(/cycle detected/);
  });

  it('accepts DAG with multiple topics and shared targets', () => {
    const manifests: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [
        { topic: 't1', target_plugins: ['B', 'C'] },
        { topic: 't2', target_plugins: ['D'] },
      ] },
      { plugin_id: 'B', mesh_routes: [{ topic: 't3', target_plugins: ['D'] }] },
      { plugin_id: 'C', mesh_routes: [] },
      { plugin_id: 'D', mesh_routes: [] },
    ];
    const table = compileRoutingTable(manifests);
    expect(table.size).toBe(3);
    expect(table.get('t2')!.has('D')).toBe(true);
  });
});

describe('Plan58 §2.4 — computeManifestIntegrityHash', () => {
  it('produces deterministic hash for canonical input', () => {
    const m1: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [{ topic: 't1', target_plugins: ['B', 'C'] }] },
      { plugin_id: 'B', mesh_routes: [] },
      { plugin_id: 'C', mesh_routes: [] },
    ];
    const m2: PluginManifestEntry[] = [
      // Same content, different order: should yield same hash.
      { plugin_id: 'C', mesh_routes: [] },
      { plugin_id: 'B', mesh_routes: [] },
      { plugin_id: 'A', mesh_routes: [{ topic: 't1', target_plugins: ['C', 'B'] }] },
    ];
    expect(computeManifestIntegrityHash(m1)).toBe(computeManifestIntegrityHash(m2));
  });

  it('produces different hash for different content', () => {
    const m1: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [{ topic: 't1', target_plugins: ['B'] }] },
      { plugin_id: 'B', mesh_routes: [] },
    ];
    const m2: PluginManifestEntry[] = [
      { plugin_id: 'A', mesh_routes: [{ topic: 't2', target_plugins: ['B'] }] },
      { plugin_id: 'B', mesh_routes: [] },
    ];
    expect(computeManifestIntegrityHash(m1)).not.toBe(computeManifestIntegrityHash(m2));
  });

  it('returns a 64-char hex SHA-256 hash', () => {
    const m: PluginManifestEntry[] = [{ plugin_id: 'X', mesh_routes: [] }];
    expect(computeManifestIntegrityHash(m)).toMatch(/^[a-f0-9]{64}$/);
  });
});
