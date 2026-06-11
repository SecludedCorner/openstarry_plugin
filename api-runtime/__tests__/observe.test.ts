/**
 * api-runtime / observe — read-only path unit tests.
 *
 * Plan59 §6.1: idempotent semantic; no replay cache attestation needed.
 */

import { describe, expect, it } from 'vitest';
import { createObserve } from '../src/observe.js';
import { PluginStateRegistry } from '../src/state.js';

function setup(initial: readonly string[] = []) {
  const registry = new PluginStateRegistry();
  for (const id of initial) registry.register(id);
  let cacheSize = 0;
  const observe = createObserve({
    registry,
    replayCacheSize: () => cacheSize,
  });
  return { registry, observe, setCacheSize: (n: number) => { cacheSize = n; } };
}

describe('observe — read-only introspection', () => {
  it('returns all registered plugins when scope omitted', () => {
    const { observe } = setup(['p1', 'p2', 'p3']);
    const result = observe({});
    expect(result.plugins.map((p) => p.plugin_id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('returns single plugin view when target_plugin scope is set', () => {
    const { observe } = setup(['p1', 'p2']);
    const result = observe({ target_plugin: 'p2' });
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].plugin_id).toBe('p2');
  });

  it('returns empty when target_plugin is not registered', () => {
    const { observe } = setup(['p1']);
    const result = observe({ target_plugin: 'absent' });
    expect(result.plugins).toEqual([]);
  });

  it('treats null/garbage scope as full-list (defensive)', () => {
    const { observe } = setup(['p1']);
    expect(observe(null).plugins).toHaveLength(1);
    expect(observe('garbage').plugins).toHaveLength(1);
  });

  it('idempotent — repeated calls produce equal results without side-effects', () => {
    const { observe } = setup(['p1']);
    const a = observe({});
    const b = observe({});
    expect(a).toEqual(b);
  });

  it('exposes replay cache size from the resolver (no nonces leaked)', () => {
    const { observe, setCacheSize } = setup(['p1']);
    setCacheSize(7);
    const result = observe({});
    expect(result.plugins[0].replay_cache_size).toBe(7);
  });

  it('default plugin view fields = info / false / false', () => {
    const { observe } = setup(['p1']);
    const view = observe({}).plugins[0];
    expect(view.log_level).toBe('info');
    expect(view.debug_flag).toBe(false);
    expect(view.soft_tracing).toBe(false);
  });

  it('boundary invariant: returned view has no ε-surface envelope fields', () => {
    const { observe } = setup(['p1']);
    const view = observe({}).plugins[0] as Record<string, unknown>;
    // ε-surface envelope fields must NOT appear in plugin-internal view.
    expect(view).not.toHaveProperty('nonce');
    expect(view).not.toHaveProperty('signature');
    expect(view).not.toHaveProperty('parent_agent_id');
    expect(view).not.toHaveProperty('capability_holdings');
    expect(view).not.toHaveProperty('hmac_signature');
  });
});
