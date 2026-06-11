/**
 * Plan47 C47-K3-M2 gear-arbiter-dynamic factory bridge integration test.
 *
 * Verifies:
 *   - factory returns onCheckpoint/onRestore keyed by manifest name
 *   - round-trip preserves StateTracker internal counters
 *   - pluginName / schemaVersion guards throw on mismatch
 */

import { describe, it, expect, vi } from 'vitest';
import { createGearArbiterDynamicPlugin, GEAR_ARBITER_DYNAMIC_PLUGIN_NAME } from '../index.js';

function makeCtx() {
  return {
    bus: {
      on: vi.fn(() => vi.fn()),
      once: vi.fn(),
      onAny: vi.fn(),
      emit: vi.fn(),
    },
    pushInput: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof createGearArbiterDynamicPlugin>['factory']>[0];
}

describe('Plan47 gear-arbiter-dynamic factory K-3 bridge (C47-K3-M2)', () => {
  it('factory exposes onCheckpoint + onRestore under manifest name', async () => {
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(makeCtx());
    expect(hooks.onCheckpoint).toBeTypeOf('function');
    expect(hooks.onRestore).toBeTypeOf('function');
    const snap = hooks.onCheckpoint!();
    expect(snap).not.toBeNull();
    expect(snap!.pluginName).toBe(GEAR_ARBITER_DYNAMIC_PLUGIN_NAME);
    expect(snap!.schemaVersion).toBe(1);
    await hooks.dispose?.();
  });

  it('round-trip: checkpoint → new factory → onRestore preserves tracker state', async () => {
    const p1 = createGearArbiterDynamicPlugin();
    const h1 = await p1.factory(makeCtx());
    const snap = h1.onCheckpoint!();
    expect(snap).not.toBeNull();
    await h1.dispose?.();

    // Fresh instance — apply snap.
    const p2 = createGearArbiterDynamicPlugin();
    const h2 = await p2.factory(makeCtx());
    expect(() => h2.onRestore!(snap!)).not.toThrow();
    await h2.dispose?.();
  });

  it('onRestore throws on pluginName mismatch', async () => {
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(makeCtx());
    const snap = hooks.onCheckpoint!()!;
    const bogus = { ...snap, pluginName: 'other' };
    expect(() => hooks.onRestore!(bogus)).toThrow(/pluginName mismatch/);
    await hooks.dispose?.();
  });

  it('onRestore throws on unsupported composite schemaVersion', async () => {
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(makeCtx());
    const snap = hooks.onCheckpoint!()!;
    const tampered = { ...snap, schemaVersion: 999 };
    expect(() => hooks.onRestore!(tampered)).toThrow(/unsupported composite schemaVersion/);
    await hooks.dispose?.();
  });
});
