/**
 * api-runtime / state — registry unit tests.
 */

import { describe, expect, it } from 'vitest';
import { PluginStateRegistry, newRecord } from '../src/state.js';

describe('PluginStateRegistry', () => {
  it('newRecord returns canonical defaults (info / false / false)', () => {
    expect(newRecord()).toEqual({ log_level: 'info', debug_flag: false, soft_tracing: false });
  });

  it('register is idempotent — re-register does not reset state', () => {
    const r = new PluginStateRegistry();
    r.register('p1');
    r.mutate('p1', { debug_flag: true });
    r.register('p1');
    expect(r.snapshot('p1')).toEqual({ log_level: 'info', debug_flag: true, soft_tracing: false });
  });

  it('snapshot returns null on unknown plugin', () => {
    const r = new PluginStateRegistry();
    expect(r.snapshot('absent')).toBeNull();
  });

  it('snapshot returns a defensive copy — caller mutations do not leak', () => {
    const r = new PluginStateRegistry();
    r.register('p1');
    const snap = r.snapshot('p1')!;
    snap.debug_flag = true;
    expect(r.snapshot('p1')!.debug_flag).toBe(false);
  });

  it('mutate applies only the specified fields (partial)', () => {
    const r = new PluginStateRegistry();
    r.register('p1');
    r.mutate('p1', { log_level: 'debug' });
    expect(r.snapshot('p1')).toEqual({ log_level: 'debug', debug_flag: false, soft_tracing: false });
    r.mutate('p1', { soft_tracing: true });
    expect(r.snapshot('p1')!.soft_tracing).toBe(true);
    expect(r.snapshot('p1')!.log_level).toBe('debug');
  });

  it('mutate returns false on unknown plugin', () => {
    const r = new PluginStateRegistry();
    expect(r.mutate('absent', { debug_flag: true })).toBe(false);
  });

  it('ids returns insertion order', () => {
    const r = new PluginStateRegistry();
    r.register('b');
    r.register('a');
    r.register('c');
    expect(r.ids()).toEqual(['b', 'a', 'c']);
  });
});
