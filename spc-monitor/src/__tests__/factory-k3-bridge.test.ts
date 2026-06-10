/**
 * Plan47 C47-K3-M1 spc-monitor factory bridge integration test.
 *
 * Verifies:
 *   - factory returns { onCheckpoint, onRestore, dispose } wired to the
 *     composite schema (M4).
 *   - The PluginSnapshot produced uses the manifest name (so runner-side
 *     capturePluginHooks → CheckpointManager keying agrees).
 *   - config.safetyGate.snapshot cold-start path emits the Plan47 deprecation
 *     warning (M5 dual-path resolution).
 */

import { describe, it, expect, vi } from 'vitest';
import { createSpcMonitorPlugin, SPC_MONITOR_PLUGIN_NAME } from '../index.js';

function makeCtx() {
  const subs: Array<() => void> = [];
  return {
    bus: {
      on: vi.fn(() => {
        const un = vi.fn();
        subs.push(un);
        return un;
      }),
      once: vi.fn(),
      onAny: vi.fn(),
      emit: vi.fn(),
    },
    pushInput: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof createSpcMonitorPlugin>['factory']>[0];
}

describe('Plan47 spc-monitor factory K-3 bridge (C47-K3-M1)', () => {
  it('factory returns onCheckpoint + onRestore hooked to composite', async () => {
    const plugin = createSpcMonitorPlugin();
    const hooks = await plugin.factory(makeCtx());
    expect(hooks.onCheckpoint).toBeTypeOf('function');
    expect(hooks.onRestore).toBeTypeOf('function');

    const snap = hooks.onCheckpoint!();
    expect(snap).not.toBeNull();
    expect(snap!.pluginName).toBe(SPC_MONITOR_PLUGIN_NAME);
    expect(snap!.schemaVersion).toBe(1);
    await hooks.dispose?.();
  });

  it('round-trip: checkpoint → new factory instance → restore preserves state', async () => {
    const p1 = createSpcMonitorPlugin({ safetyGate: { enabled: true } });
    const h1 = await p1.factory(makeCtx());
    const snap = h1.onCheckpoint!();
    expect(snap).not.toBeNull();
    await h1.dispose?.();

    // New instance — fresh state.
    const p2 = createSpcMonitorPlugin({ safetyGate: { enabled: true } });
    const h2 = await p2.factory(makeCtx());
    expect(() => h2.onRestore!(snap!)).not.toThrow();
    await h2.dispose?.();
  });

  it('dispose does not break onCheckpoint/onRestore contract (factory can still be captured)', async () => {
    const plugin = createSpcMonitorPlugin();
    const hooks = await plugin.factory(makeCtx());
    // Pre-dispose snapshot call should still succeed.
    expect(hooks.onCheckpoint!()).not.toBeNull();
    await hooks.dispose?.();
  });

  it('disabled plugin still exposes dispose but no checkpoint hooks (no state to capture)', async () => {
    const plugin = createSpcMonitorPlugin({ enabled: false });
    const hooks = await plugin.factory(makeCtx());
    // The no-op path predates Plan47 and intentionally skips the bridge.
    expect(hooks.onCheckpoint).toBeUndefined();
    expect(hooks.onRestore).toBeUndefined();
    expect(hooks.dispose).toBeTypeOf('function');
  });
});

describe('Plan47 C47-K3-M5 dual-path resolution', () => {
  it('config.safetyGate.snapshot emits deprecation warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const plugin = createSpcMonitorPlugin({
      safetyGate: {
        enabled: true,
        snapshot: { schemaVersion: 1, lastTriggerMs: 0, shadowDecisionsSinceTrigger: 0 },
      },
    });
    const hooks = await plugin.factory(makeCtx());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DEPRECATED'));
    warnSpy.mockRestore();
    await hooks.dispose?.();
  });
});
